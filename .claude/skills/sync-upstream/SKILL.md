---
name: sync-upstream
description: >-
  Resynchronise ce fork (kwop/gitlab-mcp) sur le projet upstream
  (zereight/gitlab-mcp) en rejouant les commits propres au fork ("manage
  cloudflare header", "Cloudflare Access service token") par-dessus le dernier
  upstream/main. À utiliser quand l'utilisateur veut
  rester à jour avec les nouvelles features de l'upstream, "resynchro
  upstream", "rebase sur upstream", "mettre à jour le fork".
---

# Resynchronisation du fork sur l'upstream

Ce dépôt est un **fork** :

- `origin` = `git@github.com:kwop/gitlab-mcp.git` (le fork)
- `upstream` = `https://github.com/zereight/gitlab-mcp.git` (le projet d'origine)

Le fork porte deux changements de code, tous deux pour les instances GitLab
derrière Cloudflare Access :

- le commit **« manage cloudflare header »** : token Cloudflare Access
  (`CF_TOKEN`, header `cf-access-token`) injecté dans tous les appels API GitLab ;
- la feature **« Cloudflare Access service token »** (`CF_ACCESS_CLIENT_ID` /
  `CF_ACCESS_CLIENT_SECRET`, headers `CF-Access-Client-Id` /
  `CF-Access-Client-Secret`), décrite plus bas. C'est un ajout : elle ne doit
  jamais modifier le comportement de `CF_TOKEN`.

S'y ajoutent des commits d'outillage (ce skill, `.claude/commands/sync-upstream.md`,
`CLAUDE.md`) qui se rejouent sans conflit.

## Le changement à préserver à chaque resynchro

L'upstream a migré sa configuration vers `config.ts`. La feature cloudflare
doit donc rester intégrée ainsi (et **pas** en inline dans `index.ts`) :

1. `config.ts` — à côté de `GITLAB_AUTH_COOKIE_PATH` :
   ```ts
   // Cloudflare Access token for GitLab instances protected by Cloudflare Access
   export const CF_TOKEN = getConfig("cf-token", "CF_TOKEN");
   ```
2. `server/gitlab-request-context.ts` — `CF_TOKEN` ajouté au bloc d'import
   `from "../config.js"`, et le spread dans `export const BASE_HEADERS` :
   ```ts
   ...(CF_TOKEN ? { "cf-access-token": CF_TOKEN } : {}),
   ```
   (Depuis upstream v2.3.x, `BASE_HEADERS`, `buildAuthHeaders()` et
   `getFetchConfig()` ont quitté `index.ts` pour ce module.)
3. `index.ts` — `CF_TOKEN` ajouté au bloc d'import `from "./config.js"`, et le
   spread dans l'objet `headers` de `probeGitLabUser()` (sonde `GET /user` de
   la commande CLI `doctor --probe`, qui construit ses propres headers) :
   ```ts
   const headers: Record<string, string> = {
     Accept: "application/json",
     ...(CF_TOKEN ? { "cf-access-token": CF_TOKEN } : {}),
   };
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
> assumé : les appels OAuth (`oauth.ts`, `oauth-proxy.ts` vers `/oauth/token`,
> `/oauth/token/info`, `/oauth/revoke`, et le contrôle de groupes
> `/api/v4/groups` de `oauth-proxy.ts`) n'envoient pas le header.
>
> Audit rapide des appels qui ne passent ni par `getFetchConfig()` ni par
> `BASE_HEADERS` : lister les `fetch(` / `undiciFetch(` /
> `fetchWithValidatedRedirects(` hors `test/` et regarder les ~10 lignes
> suivantes. Seuls doivent rester `downloads/proxy.ts`, `probeGitLabUser()` et
> les appels OAuth ci-dessus.

> Ne **pas** réintroduire la ligne `CF_TOKEN` dans le `README.md` : la doc des
> variables d'env a été déplacée vers `docs/configuration/environment-variables.md` upstream.

## Le second changement à préserver : Cloudflare Access service token

Quand `CF_ACCESS_CLIENT_ID` **et** `CF_ACCESS_CLIENT_SECRET` sont définies, chaque
appel à l'API GitLab (hors OAuth) porte `CF-Access-Client-Id` et
`CF-Access-Client-Secret`.
Une seule des deux : aucun des deux headers, et un warning de démarrage sur
stderr qui nomme la variable, jamais sa valeur. Aucune des deux : rien ne change.

1. `cloudflare-access.ts` (fichier propre au fork, pas de conflit attendu) —
   `resolveCloudflareAccessServiceTokenHeaders()` : renvoie `{}` ou les deux
   headers, refuse une valeur qui n'est pas de l'ASCII imprimable (fetch la
   rejetterait avec une erreur qui peut citer la valeur).
2. `config.ts` — import du resolver, puis juste après `CF_TOKEN` :
   ```ts
   export const CF_ACCESS_SERVICE_TOKEN_HEADERS = resolveCloudflareAccessServiceTokenHeaders({
     clientId: process.env.CF_ACCESS_CLIENT_ID,
     clientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
     warn: warnCloudflareAccessServiceToken,
   });
   ```
   Lecture dans `process.env` uniquement, **sans** `getConfig()` : pas d'option
   CLI, un argument se voit dans la liste des processus. Le warning passe par
   `createLogger()` + `flushStartupLogs()` (stderr), comme celui du PAT.
3. `cloudflare-access.ts` exporte aussi `guardCloudflareAccessServiceToken()`,
   appelé dans `getFetchConfig()` (`server/gitlab-request-context.ts`) autour
   du dispatcher du pool. `fetch()` suit une redirection en renvoyant tous les
   headers personnalisés à la nouvelle origine (il ne retire que
   `Authorization` et `Cookie`) ; cette garde retire les deux headers de toute
   requête dont l'origine n'est pas celle de l'API GitLab. Sans service token
   elle renvoie le dispatcher tel quel. `probeGitLabUser()` n'a pas de
   dispatcher : il passe `redirect: "manual"` quand le service token est
   configuré. Ne pas retirer ces deux protections lors d'un conflit.
4. **Partout où `cf-access-token` est posé, et seulement là**, la ligne suivante est :
   ```ts
   ...(CF_TOKEN ? { "cf-access-token": CF_TOKEN } : {}),
   ...CF_ACCESS_SERVICE_TOKEN_HEADERS,
   ```
   soit les 3 emplacements ci-dessus : `BASE_HEADERS`
   (`server/gitlab-request-context.ts`), `probeGitLabUser()` (`index.ts`) et le
   handler `/downloads/:type` (`downloads/proxy.ts`), avec l'import
   correspondant depuis `config.js`. La ligne `CF_TOKEN` elle-même ne change pas.
5. `utils/safe-redirect-fetch.ts` — `"cf-access-client-id"` et
   `"cf-access-client-secret"` dans `CREDENTIAL_HEADERS` (pas de fuite du secret
   vers l'object storage lors d'une redirection).
6. `utils/logger.ts` — les deux headers (minuscules et casse canonique, au
   premier niveau et sous `*.headers`) dans `REDACT_PATHS`.
7. `docs/configuration/environment-variables.md` — entrée
   `### \`CF_ACCESS_CLIENT_ID\` / \`CF_ACCESS_CLIENT_SECRET\`` après `CF_TOKEN`, avec
   l'exemple de lanceur qui lit le trousseau. Aucune valeur réelle, nulle part :
   ni dans la doc, ni dans les tests, ni dans un exemple de config.
8. Tests : `test/utils/cloudflare-access.test.ts` (resolver, `BASE_HEADERS`
   dans un sous-processus par combinaison de variables, garde de redirection),
   `test/cloudflare-access-service-token.test.ts` (headers reçus par un faux
   GitLab pour `doctor --probe` et le proxy de téléchargement ; demande
   `npm run build`) et la fixture `credentials` de
   `test/utils/safe-redirect-fetch.test.ts`.

> La vigilance et l'audit décrits plus haut valent pour les trois headers : un
> nouveau chemin upstream qui construit ses propres headers doit recevoir les
> deux spreads. Le trou OAuth connu s'applique aussi au service token.

## Procédure

1. `git fetch upstream`
2. Mesurer l'écart : `git rev-list --count HEAD..upstream/main` et
   `git log --oneline HEAD..upstream/main | head`.
3. `git rebase upstream/main`
4. **Conflits attendus** (l'upstream restructure souvent `index.ts` / `README.md`) :
   - Toujours **prendre le côté upstream** pour le code restructuré.
   - Réintégrer les deux features cloudflare aux emplacements ci-dessus en
     respectant l'architecture upstream courante (vérifier où se trouvent
     `BASE_HEADERS`, le bloc d'import `./config.js`, et la doc des env vars —
     ils peuvent avoir bougé). Réutiliser le helper `getConfig(...)` pour
     `CF_TOKEN` **uniquement** : le service token se lit dans `process.env`,
     jamais via `getConfig()` (pas d'option CLI pour un secret).
   - `git add` les fichiers résolus, puis `git rebase --continue`
     (avec `GIT_EDITOR=true` pour ne pas bloquer sur l'éditeur).
5. Vérifier : `npx tsc --noEmit` puis `npm run build`. Confirmer dans la sortie
   compilée : `grep -n 'cf-access-token\|CF_TOKEN' build/index.js build/config.js build/downloads/proxy.js build/utils/safe-redirect-fetch.js build/server/gitlab-request-context.js`,
   puis `grep -c 'CF_ACCESS_SERVICE_TOKEN_HEADERS' build/index.js build/config.js build/downloads/proxy.js build/server/gitlab-request-context.js`
   (chaque fichier ≥ 1) et `grep -n 'cf-access-client' build/utils/safe-redirect-fetch.js build/utils/logger.js`.
   - Si `package-lock.json` a changé : `npm ci` avant de compiler.
   - Tests ciblés (Node ≥ 22, cf. `.nvmrc`) :
     `node --import tsx/esm --test test/utils/safe-redirect-fetch.test.ts test/utils/cloudflare-access.test.ts test/cloudflare-access-service-token.test.ts`.
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
  `server/gitlab-request-context.ts`, `docs/configuration/environment-variables.md`,
  `downloads/proxy.ts`, `utils/safe-redirect-fetch.ts`,
  `test/utils/safe-redirect-fetch.test.ts` (≈22 insertions, aucune modif du `README.md`).
- Le commit « Cloudflare Access service token » est présent au-dessus, et
  `git grep -n 'CF_ACCESS_SERVICE_TOKEN_HEADERS' -- '*.ts'` montre toujours
  `config.ts` + les 3 emplacements.
- `npm run build` réussit.

## Règles

- Ne jamais créer de labels GitLab (issues ou MR).
- Toujours `--force-with-lease` (jamais `--force` nu) pour le push.
- Demander validation à l'utilisateur avant tout push qui réécrit l'historique.
