import { describe, expect, test } from "bun:test";
import { hostAllowed } from "../../src/web/server.ts";

describe("hostAllowed: the Host values the board answers", () => {
  test("localhost, 127.0.0.1 and any IPv4 literal on the served port", () => {
    expect(hostAllowed("10.1.2.3:80", 80)).toBe(true);
    expect(hostAllowed("192.168.1.59:33333", 33333)).toBe(true);
    expect(hostAllowed("172.30.33.7:33333", 33333)).toBe(true);
    expect(hostAllowed("127.0.0.1:80", 80)).toBe(true);
    expect(hostAllowed("localhost:80", 80)).toBe(true);
    expect(hostAllowed("LOCALHOST:80", 80)).toBe(true);
    expect(hostAllowed("0.0.0.0:80", 80)).toBe(true);
    expect(hostAllowed("255.255.255.255:80", 80)).toBe(true);
  });

  test("names other than localhost, another port, IPv6 and malformed values are rejected", () => {
    for (const raw of [
      null,
      undefined,
      "",
      ":80",
      "10.1.2.3",
      "10.1.2.3:81",
      "10.1.2.3:080",
      "evil.example:80",
      "myhost.local:80",
      "localhost.:80",
      "010.1.2.3:80",
      "10.1.2.256:80",
      "10.1.2.3.4:80",
      "1.2.3:80",
      "::1:80",
      "[::1]:80",
      "10.1.2.3:80:90",
      "10.1.2.3: 80",
      "10.1.2.3:80 ",
    ]) {
      expect({ raw, allowed: hostAllowed(raw, 80) }).toEqual({ raw, allowed: false });
    }
  });

  test("the predicate is pure: same input, same output", () => {
    expect(hostAllowed("10.0.0.5:33333", 33333)).toBe(hostAllowed("10.0.0.5:33333", 33333));
    expect(hostAllowed("evil.example:33333", 33333)).toBe(hostAllowed("evil.example:33333", 33333));
  });
});
