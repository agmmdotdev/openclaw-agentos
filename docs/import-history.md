# GitHub import provenance

The nine local development commits were imported through the authenticated GitHub API because command-line Git had no push credentials. Each imported commit has exactly the same file-tree hash as its corresponding original commit. GitHub assigned new commit IDs, authorship and timestamps; the original message titles, order and source-author trailers are retained. The repository's initial README commit remains their ancestor.

The complete original Git objects, authors, timestamps and commit IDs are preserved in [original-history.bundle](../history/original-history.bundle). This bundle includes all nine original commits plus the initial GitHub commit and the local integration merge. Its main tip is `04facc86b435126bf17ed0cc474f4a3ef9606867`; the original development tip is `4a5a8e4d005d1dfe417bb1112f1174ba930cb3b9`. Both tips have the same source tree.

To inspect the original history after cloning:

```sh
git bundle verify history/original-history.bundle
git fetch ./history/original-history.bundle main:original-history
git log original-history
```

| Original commit | Imported commit | Change |
| --- | --- | --- |
| `f3d1c7aa735cb303498a98cab6e8072db64e053a` | `6eb25652ed1f7464090715ac7c8b73732e781f06` | chore: restore AgentOS integration baseline |
| `5576b145a2c40eb73e2bcc04af945ea4ec9d5c2c` | `b07a42aa0d0fd20f9e4f38b06b426ec7b33f1701` | feat: add agentOS OpenClaw compatibility patch |
| `39e1640d939bb7cfdd7014d99122af8811db76a5` | `677f2169e86e1347c8bcd5a066dbb8e4087f064e` | feat: exercise OpenClaw core on published agentOS with compatibility gates |
| `2bb464b0763d802e0c05bdfb59185a9030d9780a` | `b2438f7cafdcd7e19512b3c85d6ba1eaedadf3d6` | fix: preserve async contexts and process completion in compiled core |
| `2d1e487eb1dd16f0b4d9c0424fbd23407e5e375e` | `f2aa7fc83488d68e5e9ebb14683e831ca24553c5` | perf: benchmark core runtime and isolate sidecar binding handlers |
| `dccc7fad5792feeab088cf48ab4c4f5d112f5569` | `085259e59c0f3b3dc6c7025c0e7666ea7e2a3373` | perf: shrink core profile and remove login-shell startup stall |
| `754f6c7c7b0c437ca8ce3f4c2109dbc30da1b6e9` | `fd8f35d6bcd638e5f1cf92003b64b953af1218fb` | perf: batch upstream SQLite schema inspection across host boundary |
| `01bc100394897e370afc5e6b649b1a23e70af5d3` | `add9c9d60db6990d0ae69603639bf6cba4be3c1d` | perf: reduce idle sidecar memory with pinned economy launch profile |
| `4a5a8e4d005d1dfe417bb1112f1174ba930cb3b9` | `de4f1a1ddc8110eb6e30d39166066de93bab7032` | bench: isolate OpenClaw filesystem and shell runtime bottlenecks |
