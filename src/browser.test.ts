import { expect, test } from "vitest";
import { extractUrls } from "./browser";

test("extractUrls finds the first two http(s) urls and ignores ftp://", () => {
  const text = "see https://a.com/x?y=1 and http://b.org, also ftp://c.net and https://d.io";
  expect(extractUrls(text)).toEqual(["https://a.com/x?y=1", "http://b.org"]);
  expect(extractUrls("ftp://c.net only")).toEqual([]);
});
