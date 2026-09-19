import { validateUpload, validateAvatarUpload, UploadValidationError } from "../storageService";

// Real magic-byte prefixes for each allowed type, so validateUpload's
// content-signature check (added after the mime-spoofing fix below) sees
// genuine matching bytes instead of an empty/undefined buffer.
const SIGNATURES: Record<string, Buffer> = {
  "application/pdf": Buffer.from("%PDF-1.4\n%rest of a real pdf..."),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  "image/webp": Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]),
  "application/msword": Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]),
};

function file(overrides: Partial<Express.Multer.File> & { mimetype?: string }): Express.Multer.File {
  const mimetype = overrides.mimetype ?? "application/pdf";
  return {
    mimetype,
    size: 1024,
    originalname: "test.pdf",
    buffer: SIGNATURES[mimetype] ?? Buffer.from("not a real file"),
    ...overrides,
  } as Express.Multer.File;
}

describe("validateUpload", () => {
  it("accepts an allowed mime type under the size limit, with matching real content", () => {
    expect(() => validateUpload(file({ mimetype: "application/pdf", size: 5 * 1024 * 1024 }))).not.toThrow();
  });

  it("rejects a disallowed mime type", () => {
    expect(() => validateUpload(file({ mimetype: "application/x-msdownload", buffer: Buffer.from("MZ\x90\x00") }))).toThrow(UploadValidationError);
  });

  it("rejects a file over 15MB", () => {
    expect(() => validateUpload(file({ size: 16 * 1024 * 1024 }))).toThrow(UploadValidationError);
  });

  it("accepts a file exactly at the 15MB boundary", () => {
    expect(() => validateUpload(file({ size: 15 * 1024 * 1024 }))).not.toThrow();
  });

  it("accepts docx alongside pdf/jpeg/png/doc", () => {
    expect(() =>
      validateUpload(
        file({ mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
      )
    ).not.toThrow();
  });

  // Content-signature check: a caller claiming one type while actually
  // sending another's bytes (or arbitrary bytes) is rejected instead of
  // trusted on the client-supplied Content-Type header alone. This is the
  // fix itself - the file.mimetype field multer exposes is exactly what
  // the uploader's multipart request claims it is, unverified, so nothing
  // previously stopped uploading arbitrary content (e.g. an HTML file with
  // a <script> tag) labelled as "application/pdf".
  it("rejects a mimetype claim whose content doesn't match (spoofed Content-Type)", () => {
    expect(() =>
      validateUpload(file({ mimetype: "application/pdf", buffer: SIGNATURES["image/jpeg"] }))
    ).toThrow(UploadValidationError);
  });

  it("rejects a file with no real signature at all, even with an allowed mimetype claim", () => {
    expect(() =>
      validateUpload(file({ mimetype: "application/pdf", buffer: Buffer.from("<script>alert(1)</script>") }))
    ).toThrow(UploadValidationError);
  });
});

describe("validateAvatarUpload", () => {
  it("accepts a real image under the size limit", () => {
    expect(() => validateAvatarUpload(file({ mimetype: "image/png", size: 100 * 1024 }))).not.toThrow();
  });

  it("rejects an avatar over 5MB", () => {
    expect(() => validateAvatarUpload(file({ mimetype: "image/jpeg", size: 6 * 1024 * 1024 }))).toThrow(UploadValidationError);
  });

  it("rejects spoofed content claiming to be an image", () => {
    expect(() =>
      validateAvatarUpload(file({ mimetype: "image/jpeg", buffer: Buffer.from("<script>alert(1)</script>") }))
    ).toThrow(UploadValidationError);
  });
});
