---
description: Resynchronise le fork sur zereight/gitlab-mcp (rebase + préservation des commits cloudflare)
---

Resynchronise ce fork avec l'upstream `zereight/gitlab-mcp` pour récupérer les
nouvelles features, en conservant le commit « manage cloudflare header » et la
feature « Cloudflare Access service token ».

Suis la procédure du skill **sync-upstream** (`.claude/skills/sync-upstream/SKILL.md`) :

1. `git fetch upstream` et mesure l'écart avec `upstream/main`.
2. `git rebase upstream/main`.
3. Résous les conflits en prenant le code upstream restructuré tout en
   réintégrant la feature cloudflare (`CF_TOKEN` dans `config.ts`, header
   `cf-access-token` dans `BASE_HEADERS` de `server/gitlab-request-context.ts`,
   dans `probeGitLabUser()` de `index.ts` et dans `downloads/proxy.ts`,
   `cf-access-token` dans `CREDENTIAL_HEADERS` de
   `utils/safe-redirect-fetch.ts`, doc dans
   `docs/configuration/environment-variables.md`).
   Réintègre de même la feature service token : module `cloudflare-access.ts`,
   `CF_ACCESS_SERVICE_TOKEN_HEADERS` dans `config.ts` (variables
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, sans option CLI), le spread
   `...CF_ACCESS_SERVICE_TOKEN_HEADERS` juste après chaque spread
   `cf-access-token` (les 3 mêmes emplacements), la garde
   `guardCloudflareAccessServiceToken()` dans `getFetchConfig()` et le
   `redirect: "manual"` de `probeGitLabUser()`, `cf-access-client-id` et
   `cf-access-client-secret` dans `CREDENTIAL_HEADERS` et dans `REDACT_PATHS` de
   `utils/logger.ts`, la doc, et les tests
   `test/utils/cloudflare-access.test.ts` et
   `test/cloudflare-access-service-token.test.ts`.
4. Vérifie avec `npx tsc --noEmit`, `npm run build` et
   `node --import tsx/esm --test` sur
   `test/utils/safe-redirect-fetch.test.ts`,
   `test/utils/cloudflare-access.test.ts` et
   `test/cloudflare-access-service-token.test.ts`.
5. **Demande-moi confirmation**, puis `git push --force-with-lease origin main`.

Arguments éventuels : $ARGUMENTS (ex. `--no-push` pour s'arrêter avant le push).
