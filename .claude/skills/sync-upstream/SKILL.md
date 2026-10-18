---
name: sync-upstream
description: >-
  Resynchronise ce fork (kwop/gitlab-mcp) sur le projet upstream
  (zereight/gitlab-mcp) en rejouant le commit "manage cloudflare header"
  par-dessus le dernier upstream/main. À utiliser quand l'utilisateur veut
  rester à jour avec les nouvelles features de l'upstream, "resynchro
  upstream", "rebase sur upstream", "mettre à jour le fork".
---

# Resynchronisation du fork sur l'upstream

Ce dépôt est un **fork** :

- `origin` = `git@github.com:kwop/gitlab-mcp.git` (le fork)
- `upstream` = `https://github.com/zereight/gitlab-mcp.git` (le projet d'origine)

Le seul changement de code propre au fork est le commit **« manage cloudflare header »** :
support d'un token Cloudflare Access injecté dans tous les appels API GitLab.
Il est suivi de commits d'outillage (ce skill, `.claude/commands/sync-upstream.md`,
`CLAUDE.md`) qui se rejouent sans conflit.

## Le changement à préserver à chaque resynchro

L'upstream a migré sa configuration vers `config.ts`. La feature cloudflare
doit donc rester intégrée ainsi (et **pas** en inline dans `index.ts`) :

1. `config.ts` — à côté de `GITLAB_AUTH_COOKIE_PATH` :
   ```ts
   // Cloudflare Access token for GitLab instances protected by Cloudflare Access
   export const CF_TOKEN = getConfig("cf-token", "CF_TOKEN");
   ```
2. `index.ts` — `CF_TOKEN` ajouté au bloc d'import `from "./config.js"`.
3. `index.ts` — dans `const BASE_HEADERS` :
   ```ts
   ...(CF_TOKEN ? { "cf-access-token": CF_TOKEN } : {}),
   ```
4. `docs/configuration/environment-variables.md` — entrée `### \`CF_TOKEN\`` après
   `GITLAB_AUTH_COOKIE_PATH`.
5. `downloads/proxy.ts` — le proxy de téléchargement construit **ses propres
   headers** sans passer par `BASE_HEADERS` : importer `CF_TOKEN` depuis
   `../config.js` et ajouter le spread dans l'objet `headers` initial du
   handler `/downloads/:type` :
   ```ts
   const headers: Record<string, string> = {
     Accept: "application/octet-stream",
     ...(CF_TOKEN ? { "cf-access-token": CF_TOKEN } : {}),
   };
   ```
6. `utils/safe-redirect-fetch.ts` — ajouter `"cf-access-token"` à la liste
   `CREDENTIAL_HEADERS`. Les téléchargements (`download_attachment`, artefacts
   de jobs, assets de release, `gitlab_api_request`, `downloads/proxy.ts`)
   suivent les redirections de GitLab vers l'object storage (S3, CDN) : sans
   cette entrée, le token Cloudflare part chez ces hôtes tiers. Le test
   `test/utils/safe-redirect-fetch.test.ts` (fixture `credentials` du bloc
   « credential headers across redirect hops ») vérifie qu'il est gardé en
   same-origin et retiré en cross-origin.

> Vigilance à chaque resynchro : si l'upstream ajoute un nouveau chemin qui
> appelle l'instance GitLab avec ses propres headers (comme `downloads/proxy.ts`),
> y injecter aussi `cf-access-token`. Les chemins qui passent par
> `getFetchConfig()` (dont `downloadRedirectOptions()`) héritent déjà de
> `BASE_HEADERS`. Si un appelant de `fetchWithValidatedRedirects` passe sa propre
> liste `credentialHeaders`, y ajouter aussi `cf-access-token`. Trou connu et
> assumé : les appels OAuth (`oauth.ts`, `oauth-proxy.ts` vers `/oauth/token`)
> n'envoient pas le header.

> Ne **pas** réintroduire la ligne `CF_TOKEN` dans le `README.md` : la doc des
> variables d'env a été déplacée vers `docs/configuration/environment-variables.md` upstream.

## Procédure

1. `git fetch upstream`
2. Mesurer l'écart : `git rev-list --count HEAD..upstream/main` et
   `git log --oneline HEAD..upstream/main | head`.
3. `git rebase upstream/main`
4. **Conflits attendus** (l'upstream restructure souvent `index.ts` / `README.md`) :
   - Toujours **prendre le côté upstream** pour le code restructuré.
   - Réintégrer la feature cloudflare aux 6 emplacements ci-dessus en
     respectant l'architecture upstream courante (vérifier où se trouvent
     `BASE_HEADERS`, le bloc d'import `./config.js`, et la doc des env vars —
     ils peuvent avoir bougé). Réutiliser le helper `getConfig(...)`.
   - `git add` les fichiers résolus, puis `git rebase --continue`
     (avec `GIT_EDITOR=true` pour ne pas bloquer sur l'éditeur).
5. Vérifier : `npx tsc --noEmit` puis `npm run build`. Confirmer dans la sortie
   compilée : `grep -n 'cf-access-token\|CF_TOKEN' build/index.js build/config.js build/downloads/proxy.js build/utils/safe-redirect-fetch.js`.
   - Test ciblé : `node --import tsx/esm --test test/utils/safe-redirect-fetch.test.ts`.
   - `npx prettier --check` sur les fichiers touchés. `npm run lint` passe
     depuis upstream v2.3.x (0 erreur ; les ~1000 warnings `no-explicit-any`
     viennent de l'upstream).
   - Si on corrige le commit cloudflare après le rebase : `git commit --fixup=<sha>`
     puis `git rebase --autosquash upstream/main` (pas besoin de `-i` avec git ≥ 2.44).
6. Demander confirmation avant le push, puis :
   `git push --force-with-lease origin main` (force requis : le commit a un
   nouveau parent après rebase).

## Vérification finale

- `git log --oneline upstream/main..HEAD` : « manage cloudflare header » juste
  au-dessus de `upstream/main`, suivi des commits d'outillage du fork.
- `git show --stat <sha du commit cloudflare>` : uniquement `config.ts`, `index.ts`,
  `docs/configuration/environment-variables.md`, `downloads/proxy.ts`,
  `utils/safe-redirect-fetch.ts`, `test/utils/safe-redirect-fetch.test.ts`
  (≈17 insertions, aucune modif du `README.md`).
- `npm run build` réussit.

## Règles

- Ne jamais créer de labels GitLab (issues ou MR).
- Toujours `--force-with-lease` (jamais `--force` nu) pour le push.
- Demander validation à l'utilisateur avant tout push qui réécrit l'historique.
