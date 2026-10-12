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

Le seul changement propre au fork est le commit **« manage cloudflare header »** :
support d'un token Cloudflare Access injecté dans tous les appels API GitLab.

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
4. `docs/environment-variables.md` — entrée `### \`CF_TOKEN\`` après
   `GITLAB_AUTH_COOKIE_PATH`.

> Ne **pas** réintroduire la ligne `CF_TOKEN` dans le `README.md` : la doc des
> variables d'env a été déplacée vers `docs/environment-variables.md` upstream.

## Procédure

1. `git fetch upstream`
2. Mesurer l'écart : `git rev-list --count HEAD..upstream/main` et
   `git log --oneline HEAD..upstream/main | head`.
3. `git rebase upstream/main`
4. **Conflits attendus** (l'upstream restructure souvent `index.ts` / `README.md`) :
   - Toujours **prendre le côté upstream** pour le code restructuré.
   - Réintégrer la feature cloudflare aux 4 emplacements ci-dessus en
     respectant l'architecture upstream courante (vérifier où se trouvent
     `BASE_HEADERS`, le bloc d'import `./config.js`, et la doc des env vars —
     ils peuvent avoir bougé). Réutiliser le helper `getConfig(...)`.
   - `git add` les fichiers résolus, puis `git rebase --continue`
     (avec `GIT_EDITOR=true` pour ne pas bloquer sur l'éditeur).
5. Vérifier : `npx tsc --noEmit` puis `npm run build`. Confirmer dans la sortie
   compilée : `grep -n 'cf-access-token\|CF_TOKEN' build/index.js build/config.js`.
   - `npm run lint` échoue en l'absence de `eslint.config.js` : c'est un défaut
     **préexistant upstream**, sans rapport avec la feature — ne pas le corriger ici.
6. Demander confirmation avant le push, puis :
   `git push --force-with-lease origin main` (force requis : le commit a un
   nouveau parent après rebase).

## Vérification finale

- `git log --oneline -3` : `main` = `upstream/main` + 1 commit
  « manage cloudflare header » au sommet.
- `git show HEAD --stat` : uniquement `config.ts`, `index.ts`,
  `docs/environment-variables.md` (≈8 insertions, aucune modif du `README.md`).
- `npm run build` réussit.

## Règles

- Ne jamais créer de labels GitLab (issues ou MR).
- Toujours `--force-with-lease` (jamais `--force` nu) pour le push.
- Demander validation à l'utilisateur avant tout push qui réécrit l'historique.
