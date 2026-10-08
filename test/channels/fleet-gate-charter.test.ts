import { describe, expect, it } from "vitest";
import { parseRuleTableForTest as parse } from "../../src/channels/fleet-gate.js";

// Verbatim gate_policy block from /root/hello-oracle/fleet/dobby.yaml (snapshot 2026-10-08). The first
// parser was only ever tested against an invented charter and failed on this real one.
const REAL =
  "charter:\n  name: dobby\n  gate_policy: |\n    # Gate policy 16 ข้อ — Dobby ในบท fleet approval gate (ยิ้มเคาะ 2026-07-04; หลักยึด: gate = IRREVERSIBILITY)\n    🟩 Dobby approve เองได้ (FLEET_APPROVED ได้เลย):\n    1. แก้/สร้างไฟล์ fleet repos แบบ additive + commit/push branch ตัวเอง (non-force)\n    2. รัน test / build / probe / diagnostics ทุกชนิด\n    3. restart daemon/service ของ fleet ที่ reversible + มี health check\n    4. เขียน ψ vault ตาม convention (tracks/digests/handoff)\n    5. งานใน worktree/scratch ที่ไม่แตะ main\n    6. ข้อความภายใน fleet channels\n    🟨 approve ได้ แต่ต้องแนบเหตุผล + สรุปแจ้งใน outbox (act-then-report):\n    7. แก้ cron / systemd unit ของ fleet\n    8. ติดตั้ง dependency ใหม่\n    9. merge agent branch → main ใน fleet repo ที่ review แล้ว (ตาม maw protocol)\n    🟥 ห้าม approve — FLEET_DM_OWNER: หายิ้มเสมอ:\n    10. irreversible ทุกชนิด: ลบไฟล์นอก scratch, drop DB, force-push, ลบ branch\n    11. external: อีเมล, โพสต์สาธารณะ, issue/PR นอก fleet, API ภายนอกที่เปลี่ยนสถานะ\n    12. เงินทุกกรณี (kura broadcast tx · hako สั่ง PO · koe ad spend)\n    13. secrets: ใช้ได้ตามงาน แต่ expose/ย้าย/mint ใหม่ = ยิ้มเท่านั้น\n    14. เขียนอะไรก็ตามใน FA/repo บริษัท/ภายนอก\n    15. แก้ charter/policy/ตัว gate เอง\n    16. spawn/kill bud, แก้ env production ของเพื่อน\n    กติกากลาง: ทุก approve → log ลง outbox ห้องตัวเอง (audit trail) · ลังเล = 🟥 ·\n    approve ใช้กับงานที่ขอครั้งนั้นเท่านั้น ไม่ใช่ standing permission\n  next_key: x\n    🟥 this line is outside the block\n";

describe("Dobby charter rule table", () => {
  it("parses the real gate_policy block: 1-6 green, 7-9 yellow, 10-16 red", () => {
    const rules = parse(REAL);
    expect([...rules.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((n) => [n, "green"]),
      ...[7, 8, 9].map((n) => [n, "yellow"]),
      ...[10, 11, 12, 13, 14, 15, 16].map((n) => [n, "red"]),
    ]);
  });
  it("fails closed when a rule moves tier (negative control)", () => {
    expect(() => parse(REAL.replace("🟨 approve ได้", "🟩 approve ได้"))).toThrow(
      /rule table is invalid/,
    );
  });
  it("fails closed without a gate_policy block", () => {
    expect(() => parse("charter:\n  name: dobby\n")).toThrow(/no gate_policy/);
  });
});
