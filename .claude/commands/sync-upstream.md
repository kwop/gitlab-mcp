---
description: Resynchronise le fork sur zereight/gitlab-mcp (rebase + préservation du commit cloudflare)
---

Resynchronise ce fork avec l'upstream `zereight/gitlab-mcp` pour récupérer les
nouvelles features, en conservant le commit « manage cloudflare header ».

Suis la procédure du skill **sync-upstream** (`.claude/skills/sync-upstream/SKILL.md`) :

1. `git fetch upstream` et mesure l'écart avec `upstream/main`.
2. `git rebase upstream/main`.
3. Résous les conflits en prenant le code upstream restructuré tout en
   réintégrant la feature cloudflare (`CF_TOKEN` dans `config.ts`, import dans
   `index.ts`, header `cf-access-token` dans `BASE_HEADERS` et
   `downloads/proxy.ts`, `cf-access-token` dans `CREDENTIAL_HEADERS` de
   `utils/safe-redirect-fetch.ts`, doc dans
   `docs/configuration/environment-variables.md`).
4. Vérifie avec `npx tsc --noEmit`, `npm run build` et
   `node --import tsx/esm --test test/utils/safe-redirect-fetch.test.ts`.
5. **Demande-moi confirmation**, puis `git push --force-with-lease origin main`.

Arguments éventuels : $ARGUMENTS (ex. `--no-push` pour s'arrêter avant le push).
