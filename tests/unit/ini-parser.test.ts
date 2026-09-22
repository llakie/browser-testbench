import { describe, expect, it } from "vitest";
import { IniParser } from "../../src/infrastructure/ini-parser.js";

describe("IniParser", () => {
  it("parses key-value entries independently of whitespace", () => {
    const values = IniParser.parse(`﻿# generated file
path = C:\\Users\\test\\.android\\avd\\Pixel_8_API_36.avd
image.sysdir.1=system-images\\android-36\\google_apis_playstore_ps16k\\x86_64\\
tag.ids = page_size_16kb,google_apis_playstore
empty =
url = https://example.test/?value=one
`);

    expect(Object.fromEntries(values)).toEqual({
      path: "C:\\Users\\test\\.android\\avd\\Pixel_8_API_36.avd",
      "image.sysdir.1": "system-images\\android-36\\google_apis_playstore_ps16k\\x86_64\\",
      "tag.ids": "page_size_16kb,google_apis_playstore",
      empty: "",
      url: "https://example.test/?value=one",
    });
  });

  it("ignores comments, sections, and malformed lines and keeps the last duplicate value", () => {
    const values = IniParser.parse(`; comment
[section]
invalid
key=first
key = second
`);

    expect(Object.fromEntries(values)).toEqual({ key: "second" });
  });
});
