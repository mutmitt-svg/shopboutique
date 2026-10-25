# TeleBoutik POS v3 — tenant isolation & offline outbox

## Ce que contient cette version

- Une boutique locale créée au premier lancement, avec un tenant ID stable.
- Une base PGlite/IndexedDB locale et des déclencheurs SQL qui estampillent les lignes métier avec `tenant_id`.
- Refus de démarrer si plusieurs boutiques ou des lignes appartenant à un autre tenant sont détectées dans la même base locale.
- Une outbox durable créée automatiquement dans la même transaction locale pour les INSERT/UPDATE des tables métier prises en charge. Les PIN, sels et hachages ne sont jamais ajoutés à l'outbox ; les profils d'employés synchronisés ne contiennent que les métadonnées nécessaires.
- Ventes et annulations regroupées en transactions locales ; une vente n'est confirmée à l'interface qu'après `COMMIT`.
- Synchronisation séquentielle automatique au démarrage, au retour du réseau, à la reprise de visibilité, toutes les 30 secondes et après vente/annulation.
- RPC Supabase `apply_sync_operation` avec liste blanche des entités, appartenance au tenant, contrôles de rôle et clé d'idempotence.
- Association explicite de la boutique locale au compte cloud authentifié via `register_local_store`.
- Suppression du seed de données de démonstration automatique en production.

## Configuration

1. Créez un projet Supabase de test et conservez une sauvegarde avant toute migration.
2. Configurez les variables dans `.env` à partir de `.env.example` :

   ```dotenv
   VITE_SUPABASE_URL=https://VOTRE-PROJET.supabase.co
   VITE_SUPABASE_ANON_KEY=VOTRE_CLE_PUBLIQUE
   ```

3. Installez les dépendances avec `npm ci`.
4. Appliquez les migrations dans l'ordre avec Supabase CLI ou le SQL Editor :
   - `20261023044800_create_pos_cloud_schema.sql`
   - `20261024000100_multitenant_hardening.sql`
   - `20261024000200_sync_actor_security.sql`
5. Vérifiez et corrigez le mapping des données existantes avant production. La migration bloque volontairement si elle détecte plusieurs boutiques historiques non attribuables sans ambiguïté.
6. Lancez `npm run build`, puis `npm run dev` pour les tests locaux.
7. Au premier lancement, créez le tenant local. Dans la page de connexion, utilisez **Connexion du compte cloud** pour authentifier le propriétaire. L'application associe alors le tenant à ce compte si cet ID n'existe pas déjà dans le cloud ; un tenant existant sans appartenance est refusé.

## Modèle de tenant

- Une installation locale PGlite est volontairement dédiée à un tenant. Le multi-tenant cloud permet à différents comptes/boutiques de partager le même projet Supabase, mais l'application ne permet pas encore de basculer plusieurs tenants dans une même base locale.
- Chaque table métier locale reçoit `tenant_id` par trigger. La file `sync_ops` est elle-même tenant-scoped.
- Les tables cloud métier utilisent `store_id`, qui correspond au `tenant_id` local.
- Les rôles et l'appartenance cloud sont vérifiés par les fonctions SQL, pas par le rôle React seul. Chaque opération transporte l'identifiant du membre local, puis le serveur vérifie son rôle provisionné dans `app_users`.
- Les PIN locaux ne sont pas synchronisés. Les nouveaux PIN sont dérivés avec PBKDF2-SHA-256 et un sel aléatoire ; les anciens PIN en clair sont migrés au premier login réussi. Le PIN local reste une authentification de poste hors ligne ; le compte Supabase authentifie le cloud.

## Synchronisation et limites connues

- L'outbox transmet les changements locaux supportés via `apply_sync_operation`, de manière idempotente. Les erreurs temporaires restent en attente ; les erreurs de conflit/tenant passent à l'état `conflict` pour diagnostic.
- Les écritures financières et les mouvements sont append-only côté cloud. Une correction doit être représentée par une opération compensatoire plutôt que par la suppression silencieuse d'un journal.
- Cette version implémente la poussée locale vers le cloud ; le téléchargement/merge des modifications distantes vers la base locale n'est pas encore implémenté.
- `p_base_version` est réservé à l'étape de versionnement optimiste ; cette version n'applique pas encore une résolution complète des conflits de version pour toutes les entités.
- Le navigateur ne peut pas garantir une synchronisation en arrière-plan après fermeture. La reprise automatique se fait lorsque l'application est ouverte ou revient au premier plan.
- Les tests d'intégration réels nécessitent un projet Supabase de test avec deux comptes et deux tenants. La compilation n'a pas pu être validée dans l'environnement de génération car l'installation npm a expiré faute de dépendances disponibles.

## Vérifications avant production

- Créer deux comptes Supabase et deux boutiques ; tenter des SELECT/INSERT/UPDATE croisés : tout accès inter-tenant doit être refusé.
- Envoyer deux fois le même `operation_id` et vérifier qu'un seul effet métier est appliqué.
- Simuler une vente hors ligne, fermer puis rouvrir l'application et rétablir le réseau.
- Vérifier l'ordre des dépendances : produits → variantes → IMEI → vente → lignes/paiements → mouvements.
- Vérifier les statuts `pending`, `synced`, `conflict` et `rejected`.
- Tester une annulation par vendeur (doit être refusée) et par propriétaire/gérant.
- Ne jamais exposer une clé `service_role` dans le frontend.
