# Contributing to BornAgent

Thanks for helping make agent behavior easier to understand and verify.

## Before opening a change

- Search existing issues and pull requests for related work.
- Keep the change focused. Large new capabilities should start with an issue
  that describes their authority boundary and failure behavior.
- Do not include credentials, private prompts, local session data, or generated
  contents from `.bornagent/`.

## Local setup

BornAgent requires Node.js 22.19 or newer and pnpm 11.13.1.

```powershell
corepack pnpm install
corepack pnpm check
```

`pnpm check` runs linting, type checking, tests, and the production build. Add
or update tests for behavior changes.

## Design expectations

Changes should preserve these project invariants:

- local and zero-cost execution remains the packaged default;
- capability discovery never grants effect authority by itself;
- remote providers and credential reads require an explicit trusted profile;
- denied, interrupted, and ambiguous effects fail closed;
- completion claims are backed by fresh verification evidence;
- persisted events and receipts must not contain credential values.

If a change intentionally alters one of these constraints, explain the new
threat model and migration in the pull request.

## Pull requests

Use a descriptive title and include:

- the problem and intended behavior;
- the authority or persistence surfaces affected;
- tests and verification performed;
- compatibility or migration notes, when applicable.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
