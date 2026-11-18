# Shared packages

- `contracts/`: event and DTO contracts shared by all services (issue #3).
- `common/`: outbox, messaging, auth guard, health and logging plumbing (issue #4).

Services depend on these as `workspace:*`. Change them in their own PR so every agent can rebase.
