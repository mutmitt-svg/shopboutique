# Corriger `main.tsx:1 Failed to load resource: 404`

Cette erreur signifie que le navigateur essaie de charger le point d'entrée source `/src/main.tsx`, mais que le serveur ne le trouve pas. Le cas le plus fréquent est le déploiement des fichiers source Vite au lieu du build de production. Le navigateur ne peut pas exécuter directement les fichiers TSX source en production.

## Développement local

À la racine du projet (le dossier qui contient `package.json`) :

```bash
npm ci
npm run dev
```

Ouvrir l'URL indiquée par Vite. Ne pas ouvrir `index.html` directement via `file://`.

## Production / hébergement web

```bash
npm ci
npm run build
```

Téléverser **le contenu du dossier `dist/`**, et non le dossier `src/` ou le projet source complet, dans le répertoire public de l'hébergement. Après le build, `dist/index.html` doit référencer des fichiers compilés sous `assets/` et ne doit plus demander `/src/main.tsx`.

Si l'application est publiée dans un sous-dossier, la configuration Vite `base: './'` de cette version permet d'utiliser des chemins relatifs dans le build.

Sur Apache, copier aussi le fichier `public/.htaccess` dans le dossier de publication (il sera normalement copié dans `dist/` par Vite). Il permet le fallback SPA vers `index.html` pour les routes de l'application.

## Vérifications

1. Après le build, vérifier que `dist/index.html` ne contient plus `/src/main.tsx`.
2. Vérifier que les fichiers JavaScript compilés existent dans `dist/assets/`.
3. Dans DevTools > Network, recharger sans cache et vérifier que les scripts `assets/*.js` répondent en 200.
4. Si l'erreur persiste, vider le cache du navigateur et désinscrire l'ancien Service Worker depuis DevTools > Application > Service Workers, puis recharger.
5. Ne jamais publier `.env` ni une clé Supabase privilégiée dans le frontend.

**Limite de cette archive :** les dépendances n'ont pas pu être installées dans l'environnement de préparation, donc le build de production n'a pas pu être généré ni validé ici. Il doit être produit avec `npm run build` sur une machine disposant de l'accès aux dépendances.
