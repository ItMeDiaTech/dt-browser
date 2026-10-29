| Task | System | Tool calls | Payload tokens | Schema tokens | Cumulative input tokens | Success |
|---|---|---:|---:|---:|---:|---|
| price | claude-in-chrome | 16 | 2,341 | 2,967 | 68,057 | yes |
| price | claude-in-chrome (clean path) | 9 | 982 | 2,967 | 34,154 | yes |
| price | dt-browser | 8 | 1,505 | 467 | 12,433 | yes |
| price | jev-harness | 1 | 174 | 218 | 610 | yes |
| form | claude-in-chrome | 16 | 2,209 | 2,967 | 68,950 | yes |
| form | claude-in-chrome (clean path) | 10 | 1,296 | 2,967 | 39,860 | yes |
| form | dt-browser | 10 | 2,082 | 467 | 19,727 | yes |
| form | jev-harness | 1 | 239 | 218 | 675 | yes |
| wiki | claude-in-chrome | 7 | 780 | 2,967 | 26,568 | yes |
| wiki | claude-in-chrome (clean path) | 5 | 567 | 2,967 | 19,348 | yes |
| wiki | dt-browser | 9 | 5,513 | 467 | 35,531 | yes |
| wiki | jev-harness | 1 | 213 | 218 | 649 | yes |

| System | Total cumulative input tokens (3 tasks) | vs jev-harness |
|---|---:|---:|
| claude-in-chrome | 163,575 | 84.6x |
| claude-in-chrome (clean path) | 93,362 | 48.3x |
| dt-browser | 67,691 | 35.0x |
| jev-harness | 1,934 | 1.0x |

jev-harness Jev usage (billed to TypeSafe, not the orchestrator): 15 calls, 55,463 input tokens, wall time 1883 ms, 4181 ms, 2047 ms.
