"""V1.6 G5 runtime comparator: compiled artifact vs live runtime.

Exact acceptance = full deployed runtime byte equality after substituting ONLY the
compiler-reported immutableReferences (values read from live code at the same offsets)
and linkReferences (none expected). Metadata-stripped / prefix equality are diagnostics.
"""
import hashlib, json, sys

def keccak(b: bytes) -> str:
    # Pure-python Keccak-256 (no external deps) for reproducibility on any host.
    RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
          0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
          0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
          0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
          0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
    ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
    M = (1 << 64) - 1
    rotl = lambda x, n: ((x << n) | (x >> (64 - n))) & M if n else x
    rate = 136
    msg = bytearray(b) + b"\x01"
    while len(msg) % rate: msg += b"\x00"
    msg[-1] |= 0x80
    S = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        blk = msg[off:off + rate]
        for i in range(rate // 8):
            S[i % 5][i // 5] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        for rc in RC:
            C = [S[x][0] ^ S[x][1] ^ S[x][2] ^ S[x][3] ^ S[x][4] for x in range(5)]
            D = [C[(x - 1) % 5] ^ rotl(C[(x + 1) % 5], 1) for x in range(5)]
            S = [[S[x][y] ^ D[x] for y in range(5)] for x in range(5)]
            B = [[0] * 5 for _ in range(5)]
            for x in range(5):
                for y in range(5):
                    B[y][(2 * x + 3 * y) % 5] = rotl(S[x][y], ROT[x][y])
            S = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
            S[0][0] ^= rc
    out = b"".join(S[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return "0x" + out.hex()

def split_cbor(code: bytes):
    n = int.from_bytes(code[-2:], "big")
    if n + 2 > len(code): return code, b""
    return code[: len(code) - 2 - n], code[len(code) - 2 - n:]

def compare(artifact_path: str, live_hex_path: str, label: str = ""):
    art = json.load(open(artifact_path, encoding="utf-8"))
    live = bytes.fromhex(open(live_hex_path).read().strip().removeprefix("0x"))
    return compare_objects(art["deployedBytecode"], live, label, artifact_path)

def compare_objects(dep: dict, live: bytes, label: str = "", artifact_path: str = ""):
    """dep = {object, immutableReferences, linkReferences} as emitted by solc evm.deployedBytecode."""
    compiled_hex = dep["object"].removeprefix("0x")
    link_refs = dep.get("linkReferences") or {}
    if "__$" in compiled_hex or link_refs:
        return {"label": label, "result": "UNLINKED_LIBRARIES", "linkReferences": link_refs}
    compiled = bytearray(bytes.fromhex(compiled_hex))
    imm = dep.get("immutableReferences") or {}
    substitutions = []
    for ast_id, refs in imm.items():
        for r in refs:
            s, ln = r["start"], r["length"]
            val = live[s:s + ln] if s + ln <= len(live) else b""
            substitutions.append({"astId": ast_id, "start": s, "length": ln, "compiledPlaceholder": compiled[s:s + ln].hex(), "liveValue": val.hex()})
            if len(val) == ln:
                compiled[s:s + ln] = val
    compiled = bytes(compiled)
    ce, cc = split_cbor(compiled)
    le, lc = split_cbor(live)
    first = next((i for i in range(min(len(compiled), len(live))) if compiled[i] != live[i]), None)
    if first is None and len(compiled) != len(live): first = min(len(compiled), len(live))
    first_exec = next((i for i in range(min(len(ce), len(le))) if ce[i] != le[i]), None)
    if first_exec is None and len(ce) != len(le): first_exec = min(len(ce), len(le))
    return {
        "label": label,
        "artifact": artifact_path,
        "compiledBytes": len(compiled), "liveBytes": len(live),
        "compiledKeccak256AfterImmutables": keccak(compiled), "liveKeccak256": keccak(live),
        "compiledSha256AfterImmutables": hashlib.sha256(compiled).hexdigest(), "liveSha256": hashlib.sha256(live).hexdigest(),
        "immutableSubstitutions": substitutions,
        "linkReferences": link_refs,
        "FULL_RUNTIME_EQUAL": compiled == live,
        "diagnostic_executableEqual": ce == le,
        "diagnostic_cborEqual": cc == lc,
        "compiledCbor": cc.hex(), "liveCbor": lc.hex(),
        "firstMismatchOffset": first, "firstExecutableMismatchOffset": first_exec,
        "executableLengths": [len(ce), len(le)],
    }

if __name__ == "__main__":
    r = compare(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    print(json.dumps(r, indent=1))
