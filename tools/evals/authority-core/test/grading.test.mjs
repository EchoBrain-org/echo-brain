import assert from "node:assert/strict";
import test from "node:test";
import { nearestRank95 } from "../grading.mjs";

test("nearest-rank p95 retains incorrect work as infinity", () => {
  assert.equal(nearestRank95([]), null);
  assert.equal(nearestRank95([...Array(18).fill(1), Infinity]), Infinity);
});
