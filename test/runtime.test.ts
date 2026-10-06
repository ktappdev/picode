import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectRuntime } from "../src/runtime/detect";

// No real runtime environment is consulted in these tests. In particular,
// never open the inherited Herdr daemon socket from a developer pane.
const clear = () => ({
  HERDR_ENV: "",
  HERDR_PANE_ID: "",
  HERDR_WORKSPACE_ID: "",
  HERDR_SOCKET_PATH: "",
  PICODE_RUNTIME: "",
  TUIOS_SOCKET: "",
  TUIOS_SESSION: "",
  TUIOS_PANE_ID: "",
});

describe("multiplexer selection", () => {
  it("leaves a standalone Pi session unmanaged", () =>
    assert.equal(detectRuntime(clear()), "none"));
  it("preserves Herdr auto-detection", () =>
    assert.equal(detectRuntime({ ...clear(), HERDR_ENV: "1", HERDR_PANE_ID: "w:p" }), "herdr"));
  it("honours an explicit Herdr selection", () =>
    assert.equal(
      detectRuntime({ ...clear(), PICODE_RUNTIME: "herdr", HERDR_ENV: "1", HERDR_PANE_ID: "w:p" }),
      "herdr",
    ));
  it("rejects an explicit Herdr selection with no pane identity", () =>
    assert.throws(() => detectRuntime({ ...clear(), PICODE_RUNTIME: "herdr" }), /needs HERDR_ENV/));
  // TUIOS is no longer a runtime. Its identity variables must not select
  // anything, and a stale PICODE_RUNTIME=tuios must fail loudly rather than
  // silently falling back to Herdr control calls against a foreign socket.
  it("ignores TUIOS identity variables", () =>
    assert.equal(
      detectRuntime({
        ...clear(),
        TUIOS_SOCKET: "/tmp/tuios",
        TUIOS_SESSION: "work",
        TUIOS_PANE_ID: "pane",
      }),
      "none",
    ));
  it("rejects a removed TUIOS selection", () =>
    assert.throws(
      () => detectRuntime({ ...clear(), PICODE_RUNTIME: "tuios", TUIOS_SOCKET: "/tmp/tuios" }),
      /Invalid PICODE_RUNTIME/,
    ));
});
