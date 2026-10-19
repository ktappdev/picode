import * as crypto from "node:crypto";

let seq = 0;

/** Mint a client-local id (barriers). A raw `Date.now()` collides when two
 *  ids are minted in the same millisecond (easy with sequential awaits on a
 *  fast disk); the process-lifetime counter disambiguates within a process,
 *  and the caller-supplied prefix carries the picode id for uniqueness
 *  across processes. The format is opaque — nothing parses these. */
export function mintId(prefix: string): string {
  return `${prefix}.${Date.now()}.${(seq++).toString(36)}`;
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

let lastMs = -1;
let lastRand: number[] = [];

/** A ULID: 10 chars of millisecond timestamp + 16 chars of randomness,
 *  Crockford base32 — time-sortable, so envelope filenames sort into FIFO
 *  order by construction (Appendix B). Monotonic within a process: two ids
 *  minted in the same millisecond increment the random tail instead of
 *  re-rolling it, so same-tick sends still sort in send order. */
export function ulid(now = Date.now()): string {
  if (now === lastMs) {
    for (let i = 15; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    lastRand = Array.from(crypto.randomBytes(16)).map(b => b & 31);
  }
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = B32[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  return t + lastRand.map(i => B32[i]).join("");
}

/** The RECOMMENDED envelope-id form (§6.2): `<from>/<ulid>` — globally
 *  unique by construction (sender scope + monotonic ULID), time-sortable,
 *  self-describing about origin. Opaque to receivers. */
export function mintEnvelopeId(from: string): string {
  return `${from}/${ulid()}`;
}

/** Correlate two envelope ids tolerantly. The canonical form is
 *  `<from>/<ulid>`, but agents echo ids by hand from `[...]`/`re #...`
 *  headers and sometimes drop the `<from>/` prefix — exact-match
 *  correlation then silently never fires (observed in the wild: a barrier
 *  on `coordinator/01ABC…` could not be settled by a reply echoing
 *  `01ABC…`, and the coordinator hung on it). Two ids correlate when
 *  equal, or when their post-`/` suffixes are equal and non-empty — a bare
 *  ULID and its scoped form name the same envelope. Barrier ids (mintId)
 *  carry no `/`, so they only ever match exactly; nothing echoes them. */
export function sameEnvelopeId(a: string, b: string): boolean {
  if (a === b) return true;
  const tail = (s: string) => s.slice(s.lastIndexOf("/") + 1);
  const ta = tail(a);
  const tb = tail(b);
  return ta.length > 0 && ta === tb;
}
