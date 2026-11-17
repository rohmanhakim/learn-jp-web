// P1.1 — shared types + item-key/prompt-key round-trips and rejection of
// malformed keys (Phase-001.md "P1.1 Shared types & item-key helpers").
import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  GRADES,
  LEVELS,
  PROMPT_KINDS,
  SELF_GRADES,
  VOCAB_DIRECTIONS,
  capturePromptKey,
  isBucket,
  isGrade,
  isLevel,
  isPromptKind,
  isSelfGrade,
  isVocabDirection,
  itemKeyFromPromptKey,
  kanjiItemKey,
  kanjiPromptKey,
  parseItemKey,
  parsePromptKey,
  passageItemKey,
  passagePromptKey,
  productionPromptKey,
  recallPromptKey,
  vocabItemKey,
  writingItemKey,
  writingPromptKey,
} from "../src/worker/keys";

describe("shared enums", () => {
  it("guards accept documented values", () => {
    for (const level of LEVELS) expect(isLevel(level)).toBe(true);
    for (const grade of GRADES) expect(isGrade(grade)).toBe(true);
    for (const selfGrade of SELF_GRADES) expect(isSelfGrade(selfGrade)).toBe(true);
    for (const bucket of BUCKETS) expect(isBucket(bucket)).toBe(true);
    for (const kind of PROMPT_KINDS) expect(isPromptKind(kind)).toBe(true);
    for (const direction of VOCAB_DIRECTIONS) expect(isVocabDirection(direction)).toBe(true);
  });

  it("guards reject unknown values", () => {
    expect(isLevel("n6")).toBe(false);
    expect(isLevel("")).toBe(false);
    expect(isGrade("passed")).toBe(false);
    expect(isSelfGrade("good")).toBe(false);
    expect(isBucket("grammar")).toBe(false);
    expect(isPromptKind("recall/meaning")).toBe(false);
    expect(isVocabDirection("translate")).toBe(false);
  });
});

describe("item key builders → parse round-trips", () => {
  it("builds the documented literal formats", () => {
    expect(vocabItemKey("n5", "毎朝", "meaning")).toBe("vocab:jlpt:n5:毎朝:meaning");
    expect(vocabItemKey("n5", "毎朝", "reading")).toBe("vocab:jlpt:n5:毎朝:reading");
    expect(vocabItemKey("n3", "合図", "produce")).toBe("vocab:jlpt:n3:合図:produce");
    expect(kanjiItemKey("一")).toBe("kanji:一:onkun");
    expect(passageItemKey("n4", "park", 2)).toBe("passage:n4:park:q2");
    expect(writingItemKey("n3", "school-day")).toBe("writing:n3:school-day");
  });

  it("round-trips every item key format", () => {
    expect(parseItemKey(vocabItemKey("n5", "毎朝", "meaning"))).toEqual({
      kind: "vocab",
      level: "n5",
      surface: "毎朝",
      direction: "meaning",
    });
    expect(parseItemKey(vocabItemKey("n1", "こecoregious", "produce"))).toEqual({
      kind: "vocab",
      level: "n1",
      surface: "こecoregious",
      direction: "produce",
    });
    expect(parseItemKey(kanjiItemKey("一"))).toEqual({
      kind: "kanji",
      character: "一",
      direction: "onkun",
    });
    expect(parseItemKey(passageItemKey("n4", "park-quiet", 1))).toEqual({
      kind: "passage",
      level: "n4",
      slug: "park-quiet",
      ordinal: 1,
    });
    expect(parseItemKey(writingItemKey("n3", "school-day"))).toEqual({
      kind: "writing",
      level: "n3",
      slug: "school-day",
    });
  });
});

describe("prompt key builders → parse round-trips", () => {
  it("builds the documented literal formats", () => {
    expect(recallPromptKey("n5", "毎朝", "meaning")).toBe("r:jlpt:n5:毎朝:meaning");
    expect(productionPromptKey("n3", "合図")).toBe("w:jlpt:n3:合図:produce");
    expect(passagePromptKey("n4", "park-quiet", 1)).toBe("p:n4:park-quiet:q1");
    expect(capturePromptKey("n4", "park-quiet")).toBe("capture:n4:park-quiet");
    // Shapes not shown in API.md — settled in P1.1 Notes.
    expect(kanjiPromptKey("一")).toBe("r:kanji:一:onkun");
    expect(writingPromptKey("n3", "school-day")).toBe("w:n3:school-day");
  });

  it("round-trips every prompt key format", () => {
    expect(parsePromptKey(recallPromptKey("n5", "毎朝", "reading"))).toEqual({
      kind: "recall",
      scope: "vocab",
      level: "n5",
      surface: "毎朝",
      direction: "reading",
    });
    expect(parsePromptKey(kanjiPromptKey("一"))).toEqual({
      kind: "recall",
      scope: "kanji",
      character: "一",
      direction: "onkun",
    });
    expect(parsePromptKey(productionPromptKey("n3", "合図"))).toEqual({
      kind: "production",
      level: "n3",
      surface: "合図",
    });
    expect(parsePromptKey(writingPromptKey("n3", "school-day"))).toEqual({
      kind: "writing",
      level: "n3",
      slug: "school-day",
    });
    expect(parsePromptKey(passagePromptKey("n4", "park-quiet", 3))).toEqual({
      kind: "passage_question",
      level: "n4",
      slug: "park-quiet",
      ordinal: 3,
    });
    expect(parsePromptKey(capturePromptKey("n4", "park-quiet"))).toEqual({
      kind: "capture",
      level: "n4",
      slug: "park-quiet",
    });
  });
});

describe("prompt key → item key mapping", () => {
  it("maps scheduled prompts to their SRS identity", () => {
    expect(itemKeyFromPromptKey("r:jlpt:n5:毎朝:meaning")).toBe("vocab:jlpt:n5:毎朝:meaning");
    expect(itemKeyFromPromptKey("r:jlpt:n5:毎朝:reading")).toBe("vocab:jlpt:n5:毎朝:reading");
    expect(itemKeyFromPromptKey("r:kanji:一:onkun")).toBe("kanji:一:onkun");
    expect(itemKeyFromPromptKey("w:jlpt:n3:合図:produce")).toBe("vocab:jlpt:n3:合図:produce");
    expect(itemKeyFromPromptKey("w:n3:school-day")).toBe("writing:n3:school-day");
    expect(itemKeyFromPromptKey("p:n4:park-quiet:q1")).toBe("passage:n4:park-quiet:q1");
  });

  it("capture prompts have no item key yet (D-5)", () => {
    expect(itemKeyFromPromptKey("capture:n4:park-quiet")).toBeNull();
  });

  it("returns null for malformed prompt keys", () => {
    expect(itemKeyFromPromptKey("x:jlpt:n5:毎朝:meaning")).toBeNull();
    expect(itemKeyFromPromptKey("not a key")).toBeNull();
  });
});

describe("parseItemKey rejects malformed keys", () => {
  const malformed = [
    "",
    "vocab",
    "vocab:jlpt:n5:毎朝", // missing direction
    "vocab:jlpt:n5:毎朝:meaning:extra", // too many segments
    "vocab:jlpt:n6:毎朝:meaning", // invalid level
    "vocab:jlpt:n5:毎朝:translate", // unknown direction
    "vocab:jlpt:n5::meaning", // empty surface
    "vocab:xlpt:n5:毎朝:meaning", // wrong source segment
    "vocab:jlpt:n5:毎:朝:meaning", // colon splits into 6 segments
    "kanji:一", // missing direction
    "kanji:一:foo", // not onkun
    "kanji::onkun", // empty character
    "passage:n4:park:2", // missing q prefix
    "passage:n4:park:q0", // ordinal must be ≥ 1
    "passage:n4:park:qone", // non-numeric ordinal
    "passage:n6:park:q1", // invalid level
    "writing:n3:", // empty slug
    "writing:n3", // missing slug
    "unknown:n3:x", // unknown prefix
  ];

  it.each(malformed)("rejects %j", (key) => {
    expect(parseItemKey(key)).toBeNull();
  });
});

describe("parsePromptKey rejects malformed keys", () => {
  const malformed = [
    "",
    "x:jlpt:n5:毎朝:meaning", // unknown prefix
    "r:jlpt:n5:毎朝", // missing direction
    "r:jlpt:n5:毎朝:produce", // produce is not a recall direction
    "r:jlpt:n6:毎朝:meaning", // invalid level
    "r:kanji:一", // missing direction
    "r:kanji:一:foo", // not onkun
    "r:xlpt:n5:毎朝:meaning", // wrong source segment
    "w:jlpt:n3:合図:meaning", // production must end in produce
    "w:jlpt:n3:合図:produce:extra", // too many segments
    "w:foo:school-day", // neither jlpt nor a level
    "w:n6:school-day", // invalid level
    "p:n4:park-quiet:Q1", // wrong case
    "p:n4:park-quiet:q0", // ordinal must be ≥ 1
    "capture:n4", // missing slug
    "capture:n6:park-quiet", // invalid level
  ];

  it.each(malformed)("rejects %j", (key) => {
    expect(parsePromptKey(key)).toBeNull();
  });
});

describe("builders throw on invalid segments", () => {
  it("rejects empty segments", () => {
    expect(() => vocabItemKey("n5", "", "meaning")).toThrow();
    expect(() => kanjiItemKey("")).toThrow();
    expect(() => passageItemKey("n4", "", 1)).toThrow();
    expect(() => writingPromptKey("n3", "")).toThrow();
  });

  it("rejects colons inside segments", () => {
    expect(() => vocabItemKey("n5", "a:b", "meaning")).toThrow();
    expect(() => kanjiPromptKey("a:b")).toThrow();
    expect(() => recallPromptKey("n5", "a:b", "reading")).toThrow();
  });

  it("rejects non-positive ordinals", () => {
    expect(() => passageItemKey("n4", "park", 0)).toThrow();
    expect(() => passagePromptKey("n4", "park", -1)).toThrow();
    expect(() => passagePromptKey("n4", "park", 1.5)).toThrow();
  });
});