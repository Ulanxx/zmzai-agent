import { describe, expect, it } from "vitest";

import { decodeSessionUpload, maxSessionUploadBytes, SessionFileUploadError, uploadPath } from "./session-file-upload";

describe("session file upload", () => {
  it("normalizes a safe relative path", () => {
    expect(uploadPath({ filename: "./data/sales.csv" })).toBe("data/sales.csv");
    expect(uploadPath({ filename: "sales.csv", requestedPath: "inputs/sales.csv" })).toBe("inputs/sales.csv");
  });

  it("rejects traversal, oversized, binary, and invalid UTF-8 input", () => {
    expect(() => uploadPath({ filename: "../secrets.txt" })).toThrow(SessionFileUploadError);
    expect(() => decodeSessionUpload(new Uint8Array(maxSessionUploadBytes + 1))).toThrow("不能超过");
    expect(() => decodeSessionUpload(new Uint8Array([65, 0, 66]))).toThrow("只支持文本");
    expect(() => decodeSessionUpload(new Uint8Array([0xc3, 0x28]))).toThrow(SessionFileUploadError);
  });
});
