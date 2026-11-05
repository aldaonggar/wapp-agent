import { expect, test } from "vitest";
import { tzFromPhone } from "./timezone";

test("tzFromPhone picks the longest calling-code prefix, else UTC", () => {
  expect(tzFromPhone("77011234567")).toBe("Asia/Almaty");
  expect(tzFromPhone("76011234567")).toBe("Asia/Almaty");
  expect(tzFromPhone("79161234567")).toBe("Europe/Moscow");
  expect(tzFromPhone("447700900123")).toBe("Europe/London");
  expect(tzFromPhone("15551234567")).toBe("America/New_York");
  expect(tzFromPhone("99999")).toBe("UTC");
});
