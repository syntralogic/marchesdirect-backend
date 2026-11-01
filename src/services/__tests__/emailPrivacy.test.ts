jest.mock('../../utils/logger',()=>({logger:{warn:jest.fn(),error:jest.fn()}}));
import { logger } from '../../utils/logger';
import { sendEmail } from '../emailService';
import { sanitizeLogValue,redactLogText } from '../../utils/logPrivacy';
const payload={to:'private@example.com',subject:'SECRET-SUBJECT',html:'<p>SECRET-BODY <a href="https://site/login?token=SECRET-MAGIC">Sign in</a></p>'};
beforeEach(()=>{jest.clearAllMocks();delete process.env.RESEND_API_KEY;delete process.env.EMAIL_FROM;global.fetch=jest.fn();});
it('missing provider never prints or sends the message',async()=>{
  expect(await sendEmail(payload)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  const logs=JSON.stringify((logger.warn as jest.Mock).mock.calls);
  expect(logs).not.toMatch(/private@|SECRET/);
});
it('provider failure never includes its body in errors or logs',async()=>{
  process.env.RESEND_API_KEY='test-only';process.env.EMAIL_FROM='Dossiers <dossiers@example.com>';
  const json=jest.fn().mockResolvedValue(payload);
  (fetch as jest.Mock).mockResolvedValue({ok:false,status:422,json,body:{cancel:jest.fn()}});
  await expect(sendEmail(payload)).rejects.toThrow('resend_http_422');
  expect(json).not.toHaveBeenCalled();
  expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toMatch(/private@|SECRET/);
});
it('redacts nested error/request metadata, credentials, phone and magic links',()=>{
  const err=Object.assign(new Error('private@example.com +33 6 12 34 56 78 https://site/login?token=SECRET-MAGIC'),{response:{status:500,data:payload},config:{headers:{Authorization:'Bearer SECRET'}}});
  const result=JSON.stringify(sanitizeLogValue({err,body:payload,contact:{email:payload.to},nested:{token:'SECRET-TOKEN'}}));
  expect(result).not.toMatch(/private@|SECRET|12 34|https:\/\/site/);
  expect(result).toContain('500');
  expect(redactLogText('GET /auth/callback?token=secret')).not.toContain('secret');
});
