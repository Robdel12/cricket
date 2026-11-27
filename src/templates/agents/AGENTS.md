<!-- cricket-agent-guidance -->
## Cricket App Guidance

Read `api/index.js` and the domain you are changing. Domains live in
`api/domains/`. Cricket loads the standard files directly inside each domain
folder. Add files as needed.

| File | What goes there |
| --- | --- |
| `*.model.js` | Stored rows, public and private fields, named views |
| `*.validations.js` | Request, source, and service input schemas |
| `*.normalizers.js` | Pure functions that shape outside data |
| `*.serializers.js` | Public API output |
| `*.service.js` | Queries, writes, and integration calls |
| `*.rules.js` | Auth, ownership, existence, and business checks |
| `*.routes.js` | Endpoint contracts and thin handlers |
| `*.machine.js` | Product states and events |
| `*.jobs.js` | Background job contracts |
| `*.test.js` | Domain behavior tests |

Import route schemas explicitly. Keep Cricket definitions immutable and pass
plain data between functions. Use `api/middleware/` for shared HTTP behavior,
`api/services/` for shared capabilities, `api/workers/` for worker entrypoints,
and `api/migrations/` for database changes. Keep `api/dev/` local-only.

Choose a skill for the task.

- [cricket](.agents/skills/cricket/SKILL.md) for domains, endpoints, and app wiring.
- [cricket-jobs](.agents/skills/cricket-jobs/SKILL.md) for queues and workers.
- [cricket-machines](.agents/skills/cricket-machines/SKILL.md) for product state and events.
- [cricket-observability](.agents/skills/cricket-observability/SKILL.md) for logs, traces, and runtime lifecycle.
- [cricket-testing](.agents/skills/cricket-testing/SKILL.md) for HTTP, job, and machine tests.
<!-- /cricket-agent-guidance -->
