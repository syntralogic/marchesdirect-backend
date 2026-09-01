import { db } from '../config/database';
import { logger } from '../utils/logger';

// ============================================================================
// DEDUPLICATION LOGIC (MILESTONE 3)
// ============================================================================

/**
 * Detect and merge duplicate opportunities across different data sources
 * Example: Same tender published on BOAMP and PLACE with slight formatting differences,
 * or on BOAMP and the buyer's own profil acheteur (both then re-surfaced via DECP) -
 * this second case is the exact one the client called out as a good, 100%-legal
 * training ground for this matcher (real open-data duplicates, no need to wait
 * for private-source coverage to start tuning it).
 *
 * Scores on the 4 signals the client named - objet (title), acheteur (buyer_name),
 * montant (estimated_value), date (deadline) - rather than title+deadline alone:
 * title is the primary signal, buyer_name and montant corroborate it, which
 * catches both false positives (similar title, different buyer/amount - a
 * different lot of a recurring annual marché, say) and lets through matches a
 * looser title match alone might miss (BOAMP's "objet" wording and a profil
 * acheteur's manually re-typed one legitimately diverge more than a strict
 * title-similarity threshold allows for).
 */

export const deduplicateOpportunities = async (): Promise<number> => {
  try {
    // Cast a wider net at the SQL level than the old fixed thresholds (title
    // similarity > 0.75, deadline within 24h) - the buyer_name/montant
    // signals below now do the precision work in JS via a composite score,
    // so a candidate just needs SOME plausible overlap to be worth scoring.
    const potentialDuplicates = await db.query(`
      SELECT 
        o1.id as id1,
        o2.id as id2,
        o1.title,
        o2.title,
        similarity(o1.title, o2.title) as title_similarity,
        similarity(COALESCE(o1.buyer_name, ''), COALESCE(o2.buyer_name, '')) as buyer_similarity,
        ABS(EXTRACT(EPOCH FROM (o1.deadline - o2.deadline))) as deadline_diff_seconds,
        o1.estimated_value as value1,
        o2.estimated_value as value2
      FROM opportunities o1
      JOIN opportunities o2 ON 
        o1.source_id < o2.source_id AND  -- Avoid duplicates
        o1.id < o2.id AND                 -- Ensure consistent ordering
        similarity(o1.title, o2.title) > 0.5 AND  -- wide candidate net - final decision is the composite score below
        (o1.deadline IS NULL OR o2.deadline IS NULL OR ABS(EXTRACT(EPOCH FROM (o1.deadline - o2.deadline))) < 172800) AND  -- within 48h, or either side has no deadline (DECP has none - see collectDecpData)
        o1.deleted_at IS NULL AND o2.deleted_at IS NULL AND
        o1.status NOT IN ('cancelled', 'expired') AND o2.status NOT IN ('cancelled', 'expired')
      WHERE NOT EXISTS (
        SELECT 1 FROM opportunity_duplicates 
        WHERE (primary_opportunity_id = o1.id AND duplicate_opportunity_id = o2.id)
           OR (primary_opportunity_id = o2.id AND duplicate_opportunity_id = o1.id)
      )
      ORDER BY title_similarity DESC
      LIMIT 300
    `);

    logger.info(`Found ${potentialDuplicates.rows.length} potential duplicates`);

    let mergedCount = 0;

    for (const dup of potentialDuplicates.rows) {
      const titleSim: number = dup.title_similarity;
      const buyerSim: number = dup.buyer_similarity || 0;
      const sameDay = dup.deadline_diff_seconds != null && dup.deadline_diff_seconds < 86400;
      const hasBothValues = dup.value1 != null && dup.value2 != null && Number(dup.value1) > 0;
      const valueDiffRatio = hasBothValues
        ? Math.abs(Number(dup.value1) - Number(dup.value2)) / Number(dup.value1)
        : null;

      // Composite confidence across the 4 client-named signals. Weighted
      // toward title (the most reliable single signal in French tender
      // notices) with buyer_name and montant corroborating; amount being
      // meaningfully different actively counts against a match rather than
      // being ignored, since two genuinely distinct lots from the same
      // buyer around the same date is a real, common false-positive case.
      let confidence = titleSim * 0.55 + buyerSim * 0.25;
      if (sameDay) confidence += 0.1;
      if (valueDiffRatio !== null) {
        if (valueDiffRatio < 0.02) confidence += 0.1;
        else if (valueDiffRatio > 0.15) confidence -= 0.2;
      }

      // Still require real title overlap even at high buyer/amount
      // agreement - two different lots from the same recurring buyer for
      // the same recurring amount shouldn't merge just because those two
      // signals matched.
      if (confidence >= 0.82 && titleSim > 0.6) {
        const merged = await mergeDuplicates(dup.id1, dup.id2, confidence, {
          title_similarity: Math.round(titleSim * 100) / 100,
          buyer_similarity: Math.round(buyerSim * 100) / 100,
          deadline_same_day: sameDay,
          value_diff_ratio: valueDiffRatio !== null ? Math.round(valueDiffRatio * 1000) / 1000 : null,
        });
        if (merged) mergedCount++;
      }
    }

    logger.info(`Merged ${mergedCount} duplicate opportunity pairs`);
    return mergedCount;
  } catch (err) {
    logger.error('Deduplication error:', err);
    return 0;
  }
};

/**
 * Merge two opportunities, keeping one as primary and marking the other as duplicate
 */
const mergeDuplicates = async (
  primaryId: string,
  secondaryId: string,
  confidence: number,
  matchingFields: Record<string, any>
): Promise<boolean> => {
  try {
    await db.transaction(async (client) => {
      // Record the duplicate relationship
      await client.query(
        `INSERT INTO opportunity_duplicates 
          (primary_opportunity_id, duplicate_opportunity_id, similarity_score, matching_fields)
         VALUES ($1, $2, $3, $4)`,
        [
          primaryId,
          secondaryId,
          Math.round(confidence * 100) / 100,
          JSON.stringify(matchingFields),
        ]
      );

      // Merge metadata (take non-null values from secondary)
      const secondary = await client.query(
        'SELECT * FROM opportunities WHERE id = $1',
        [secondaryId]
      );

      const sec = secondary.rows[0];

      await client.query(
        `UPDATE opportunities SET
          estimated_value = COALESCE(estimated_value, $1),
          location_latitude = COALESCE(location_latitude, $2),
          location_longitude = COALESCE(location_longitude, $3),
          updated_at = NOW()
         WHERE id = $4`,
        [sec.estimated_value, sec.location_latitude, sec.location_longitude, primaryId]
      );

      // Optionally mark secondary as merged (don't delete for audit trail)
      await client.query(
        'UPDATE opportunities SET status = $1, updated_at = NOW() WHERE id = $2',
        ['merged', secondaryId]
      );
    });

    logger.debug(`Merged opportunities: ${primaryId} (primary) + ${secondaryId} (duplicate)`);
    return true;
  } catch (err) {
    logger.error(`Failed to merge duplicates (${primaryId}, ${secondaryId}):`, err);
    return false;
  }
};

/**
 * Find best match for a given opportunity across other sources
 * Used for matching aggregated/scraped data to official sources
 */
export const findMatchingOpportunity = async (
  title: string,
  deadline: Date,
  sourceId: number
): Promise<string | null> => {
  try {
    const result = await db.query(`
      SELECT o.id,
             similarity($1, o.title) as title_sim,
             ABS(EXTRACT(EPOCH FROM ($2::timestamp - o.deadline))) as deadline_diff
      FROM opportunities o
      WHERE o.source_id != $3
        AND o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'expired')
        AND similarity($1, o.title) > 0.8
        AND ABS(EXTRACT(EPOCH FROM ($2::timestamp - o.deadline))) < 86400
      ORDER BY title_sim DESC, deadline_diff ASC
      LIMIT 1
    `, [title, deadline, sourceId]);

    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (err) {
    logger.error('Error finding matching opportunity:', err);
    return null;
  }
};

/**
 * Verify deduplication quality (proof for Milestone 3)
 * Import same data twice and verify zero duplicates are created
 */
export const verifyDeduplicationQuality = async () => {
  try {
    // Check for records with exact same source_reference from same source
    const result = await db.query(`
      SELECT source_id, source_reference, COUNT(*) as count
      FROM opportunities
      WHERE deleted_at IS NULL
      GROUP BY source_id, source_reference
      HAVING COUNT(*) > 1
    `);

    const duplicates = result.rows;

    if (duplicates.length > 0) {
      logger.warn(`⚠️  Found ${duplicates.length} duplicate source references!`);
      duplicates.forEach(dup => {
        logger.warn(`  Source ${dup.source_id}, Ref ${dup.source_reference}: ${dup.count} records`);
      });
      return false;
    }

    logger.info('✅ Deduplication verified: No exact duplicates found');

    // Also check for cross-source duplicates that were properly merged
    const mergedCount = await db.query(`
      SELECT COUNT(*) as count FROM opportunity_duplicates
    `);

    logger.info(`✅ Successfully merged ${mergedCount.rows[0].count} opportunity pairs across sources`);
    return true;
  } catch (err) {
    logger.error('Deduplication verification failed:', err);
    return false;
  }
};

/**
 * Generate report of deduplication activity (for audit/compliance)
 */
export const getDeduplicationReport = async () => {
  try {
    const report = {
      total_opportunities: 0,
      duplicates_detected: 0,
      duplicates_merged: 0,
      by_source: {},
      by_date: {},
    };

    // Total opportunities
    const totalResult = await db.query(
      'SELECT COUNT(*) as count FROM opportunities WHERE deleted_at IS NULL'
    );
    report.total_opportunities = parseInt(totalResult.rows[0].count);

    // Merged duplicates
    const mergedResult = await db.query(
      'SELECT COUNT(*) as count FROM opportunity_duplicates'
    );
    report.duplicates_merged = parseInt(mergedResult.rows[0].count);

    // By source
    const bySourceResult = await db.query(`
      SELECT ds.name, COUNT(o.id) as count
      FROM data_sources ds
      LEFT JOIN opportunities o ON ds.id = o.source_id
      WHERE o.deleted_at IS NULL
      GROUP BY ds.id, ds.name
    `);

    bySourceResult.rows.forEach(row => {
      report.by_source[row.name] = row.count;
    });

    return report;
  } catch (err) {
    logger.error('Failed to generate deduplication report:', err);
    throw err;
  }
};
