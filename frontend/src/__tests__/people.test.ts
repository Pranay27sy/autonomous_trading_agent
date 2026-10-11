import { describe, expect, it } from "vitest";
import { personSlug } from "../pages/People";

describe("personSlug", () => {
  it("matches service.person_slug on the server", () => {
    expect(personSlug("Ravi  Kumar.")).toBe("ravi-kumar");
    expect(personSlug("RAVI KUMAR")).toBe("ravi-kumar");
    expect(personSlug("CK Trustees Private Limited (in its capacity as trustee)")).toBe(
      "ck-trustees-private-limited-in-its-capacity-as-trustee",
    );
    expect(personSlug(null)).toBe("");
  });
});
