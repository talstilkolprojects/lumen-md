/** AWS Signature V4 (plan 3.5): the worked example from AWS's documentation. */
import { describe, expect, it } from "vitest";
import { amzDate, signRequest } from "../sync/e2ee/providers/sigv4";

describe("SigV4", () => {
  const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const date = new Date("2013-05-24T00:00:00Z");

  it("reproduces the GET object example (Authenticating Requests, AWS Signature Version 4)", async () => {
    const h = await signRequest(creds, { method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" }, region: "us-east-1", date });
    expect(h.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
    expect(h["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("signs the body hash, the query (sorted) and a session token", async () => {
    const a = await signRequest(creds, { method: "PUT", url: "https://s3.example/b/k", body: new Uint8Array([1, 2, 3]), region: "eu-central-1", date });
    const b = await signRequest(creds, { method: "PUT", url: "https://s3.example/b/k", body: new Uint8Array([1, 2, 4]), region: "eu-central-1", date });
    expect(a.Authorization).not.toBe(b.Authorization);
    const c = await signRequest({ ...creds, sessionToken: "tok" }, { method: "GET", url: "https://s3.example/b/?list-type=2&prefix=x%2F", region: "eu-central-1", date });
    expect(c["x-amz-security-token"]).toBe("tok");
    expect(c.Authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
    expect(amzDate(date)).toBe("20130524T000000Z");
  });
});
