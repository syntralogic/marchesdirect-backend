import { errorHandler, ApiError, asyncHandler } from "../errorHandler";
import type { Request, Response } from "express";

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { id: "req-1", path: "/test", method: "GET", ...overrides } as unknown as Request;
}

describe("errorHandler", () => {
  it("returns the ApiError's own status code and message", () => {
    const res = mockRes();
    const err = new ApiError(422, "Champ requis manquant");

    errorHandler(err, mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Champ requis manquant", requestId: "req-1" })
    );
  });

  it("maps a Postgres constraint violation (23xxx code) to a 400", () => {
    const res = mockRes();
    const err = { code: "23505", detail: "Key already exists", message: "duplicate key" };

    errorHandler(err, mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Database constraint violation", message: "Les données transmises ne peuvent pas être enregistrées." })
    );
  });

  it("maps an expired JWT to a 401 with a stable message", () => {
    const res = mockRes();
    const err = { name: "TokenExpiredError", message: "jwt expired" };

    errorHandler(err, mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Token expired" }));
  });

  it("falls back to 500 for an unrecognised error shape", () => {
    const res = mockRes();
    errorHandler(new Error("boom"), mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Une erreur est survenue. Réessayez dans quelques instants." }));
  });

  it("does not leak the stack trace outside development", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const res = mockRes();

    errorHandler(new Error("boom"), mockReq(), res, jest.fn());

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.stack).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('boom');

    process.env.NODE_ENV = originalEnv;
  });
});

describe("asyncHandler", () => {
  it("forwards a rejected promise to next() instead of throwing", async () => {
    const next = jest.fn();
    const failing = async () => {
      throw new Error("async failure");
    };

    await asyncHandler(failing)(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe("async failure");
  });

  it("does not call next() when the handler resolves normally", async () => {
    const next = jest.fn();
    const ok = async () => "done";

    await asyncHandler(ok)(mockReq(), mockRes(), next);

    expect(next).not.toHaveBeenCalled();
  });
});

