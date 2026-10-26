# Maintainers and project decisions

John Owolabi Idogun ([`@Sirneij`](https://github.com/Sirneij)) maintains Schemd and currently
holds release and repository administration authority. There is no second appointed maintainer.
Additional maintainers are appointed by a documented agreement with the current maintainer and
the person accepting responsibility; access is granted only after their role is agreed.

## Decisions and reviews

Use an issue to agree on substantial API, compatibility, or architectural changes before coding.
Record the decision and its reasons in that issue, then link it from the implementing PR.
Small fixes can go directly to a PR. Existing project requirements and contribution guidance
remain the acceptance criteria.

Changes to `main` require a PR, current successful verification, and resolved review conversations.
Code owners review contributions. A separate review ruleset requires an independent approval.
Repository administrators can bypass that review rule through a PR while there is only one
maintainer, but cannot bypass the separate required-CI ruleset. Such a merge must explain why an
independent reviewer was unavailable and record the validation performed. Direct pushes are not
the exception path.

## Access and continuity

Organisation membership requires 2FA. Use the minimum repository role needed for the work.
Review access when a maintainer joins or leaves and after a suspected compromise. Never share
personal credentials. Publishing uses the repository's npm trusted-publisher workflow.

An ownership transfer must identify the incoming maintainer publicly, obtain their agreement,
and verify their GitHub and npm access before removing the outgoing maintainer. Recovery codes
and private account recovery procedures must remain outside this public repository. Until another
maintainer accepts responsibility, the single-maintainer continuity risk remains explicit.

## Repository safeguards

`main` blocks deletion and force pushes. Release tags are created by administrators and cannot
be moved or deleted. Future GitHub releases are immutable. CI actions are pinned to full SHAs;
Dependabot proposes reviewed updates for actions and Bun dependencies. Required CI remains
mandatory for dependency and automation PRs.

See [SECURITY.md](./SECURITY.md) for reporting and supported versions, and
[SUPPORT.md](./SUPPORT.md) for the appropriate public channel.
