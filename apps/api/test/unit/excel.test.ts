import { describe, expect, it } from "vitest";
import { LEAD_COLUMNS, mapHeaders, normalizeHeader } from "@mailapp/shared";
import { buildLeadImport, buildServiceImport, isValidEmail, parseSheet, splitList } from "../../src/modules/excel/import.js";
import { xlsxBuffer } from "../helpers/fixtures.js";

describe("header mapping", () => {
  it("normalises headers", () => {
    expect(normalizeHeader("  E-Mail Address ")).toBe("e mail address");
    expect(normalizeHeader("First_Name")).toBe("first name");
  });

  it("maps aliases case-insensitively and reports unmapped + missing", () => {
    const r = mapHeaders(["Email Address", "FIRST NAME", "Company Name", "Region", "Website URL"], LEAD_COLUMNS);
    expect(r.mapped).toEqual({ "Email Address": "email", "FIRST NAME": "first_name", "Company Name": "company", Region: "location" });
    expect(r.unmapped).toEqual(["Website URL"]);
    expect(r.missingRequired).toEqual([]);
  });

  it("flags missing email column", () => {
    const r = mapHeaders(["Name", "Company"], LEAD_COLUMNS);
    expect(r.missingRequired).toEqual(["email"]);
  });

  it("keeps the first of duplicate mapped columns", () => {
    const r = mapHeaders(["Email", "E-mail"], LEAD_COLUMNS);
    expect(r.mapped).toEqual({ Email: "email" });
    expect(r.unmapped).toEqual(["E-mail"]);
  });
});

describe("parseSheet + buildLeadImport", () => {
  it("parses xlsx, validates emails, dedupes and preserves extra columns", async () => {
    const buf = await xlsxBuffer(
      ["First Name", "Email", "Company", "Owner"],
      [
        ["Ann", "ann@acme.com", "Acme", "sam"],
        ["Bob", "not-an-email", "Beta", "sam"],
        ["Cat", "ANN@acme.com", "Acme", "sam"],
        ["", "", "", ""],
        ["Dee", "dee@delta.io", "Delta", "kim"],
      ],
    );
    const sheet = await parseSheet(buf, "leads.xlsx");
    expect(sheet.headers).toEqual(["First Name", "Email", "Company", "Owner"]);
    expect(sheet.rows).toHaveLength(4);
    const imp = buildLeadImport(sheet);
    expect(imp.valid.map((v) => v.email)).toEqual(["ann@acme.com", "dee@delta.io"]);
    expect(imp.invalid).toEqual([{ row: 3, reason: 'invalid email "not-an-email"' }]);
    expect(imp.duplicates).toBe(1);
    expect(imp.valid[0].fields).toEqual({ first_name: "Ann", email: "ann@acme.com", company: "Acme" });
    expect(imp.valid[0].extra).toEqual({ Owner: "sam" });
    expect(imp.unmapped).toEqual(["Owner"]);
  });

  it("parses csv", async () => {
    const csv = Buffer.from("email,company\nx@y.com,Y Co\n");
    const sheet = await parseSheet(csv, "leads.csv");
    expect(sheet.rows).toEqual([{ email: "x@y.com", company: "Y Co" }]);
  });

  it("rejects empty sheets", async () => {
    const buf = await xlsxBuffer([], []);
    await expect(parseSheet(buf, "x.xlsx")).rejects.toThrow(/empty/i);
  });

  it("validates emails", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
  });
});

describe("service import", () => {
  it("maps service columns and splits lists", async () => {
    const buf = await xlsxBuffer(
      ["Service", "Description", "Benefits", "Tags"],
      [
        ["Audit", "We audit things", "fast; cheap", "finance|risk"],
        ["", "missing name", "", ""],
      ],
    );
    const sheet = await parseSheet(buf, "s.xlsx");
    const r = buildServiceImport(sheet);
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual([{ row: 3, reason: "missing name" }]);
    expect(splitList(r.rows[0].fields.value_props)).toEqual(["fast", "cheap"]);
    expect(splitList(r.rows[0].fields.tags)).toEqual(["finance", "risk"]);
  });
});
