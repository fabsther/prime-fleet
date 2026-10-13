# Prime Fleet — décisions de la revue du plan (13/10/2026)
1. Techno : React + Vite + Tauri 2 (Windows/macOS/Linux/Android/iOS). Appels API v1 via couche Rust (aucun en-tête Origin : Studio renvoie 403 sinon).
2. Synchro : route du créateur POST /api/v1/projects/{projectId}/sync {sessionId?} (permission sync:write) + GET /api/v1/sync (read). Parcours : fin du run sur A -> sync A -> sync B -> run sur B. Demandes au créateur : capacité "sync" dans /machine, enum de state, timeout/409, correctif envoi après run. Repli sans capacité : comparer le dernier message.
3. Skills Fleet : dossier prime-fleet/skills déclaré dans les réglages "skills" de Prime Agent (git pull pour mettre à jour). Aucune modif de Studio.
4. UI : reprise des styles CSS de Studio (MIT, mention conservée), composants React avec les mêmes classes.
5. Livraison : tout d'un coup (conversations, Roadmap, campagnes, Computer Use, skills), découpée en étapes internes testables ; recette finale = campagne Pieton.
6. Écran partagé : zones libres comme Studio (onglets) ; défaut conversation | Roadmap ; projets dans un tiroir. Tablette : vertical en paysage, horizontal en portrait. Téléphone : une zone sauf écran externe.
7. Jetons : coffre du système (Keystore, Keychain, Credential Manager) via plugin keyring Tauri.
8+9. Skills sur PC : utilisent le coffre de l'app via la commande de l'exécutable de bureau : `prime-fleet api <machine> <METHOD> <path> [body]` (pas de jeton en clair, pas de dépendance Python).
Autres acquis : conversations indépendantes des machines (dernier agent + sélecteur de machine), markups @machine: / @campaign, Computer Use par /api/v1/computer-use (1 propriétaire par machine), dépôt public séparé "prime-fleet".

10. Hors version actuelle : bouton « + » pour ajouter au projet une machine qui ne l'a pas (création de la conversation sur la cible, installation guidée par WorkspaceSetup.md maintenu dans le dépôt et référencé dans AGENTS.md, commit + push). Bloqué par l'API v1 : pas de création/enregistrement de projet. Idée gardée pour plus tard (demande possible au créateur : POST /api/v1/projects {cwd}, scope projects:write).

4 bis. UI : skill `prime-agent-studio-style` (Studio 4.3.2, MIT) : assets/studio.css (classes ps-), icons.esm.js, theme.js copiés dans app/ avec leur LICENSE ; composants React = markup de example-shell.html / components.html ; textes selon references/writing.md ; revue finale avec references/checklist.md + captures. Breakpoints du skill (<=760 px mobile, tiroir) + règle tablette (2 zones, sens selon orientation).
Écart volontaire à references/multi-instance.md : barre latérale = Projets → Conversations (pas Machines → Projets), car une conversation appartient au projet ; la machine apparaît en point de couleur machine + « dernier agent : X » ; fil d'Ariane = Projet / Conversation + pastille machine ; écran « Machines » (.ps-machine-list / cartes .ps-card) séparé.
