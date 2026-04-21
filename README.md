# BIONOVA Academy — Webhook Server

Servidor Node.js que escucha pagos de Shopify y activa automáticamente a los miembros en Firebase.

## Variables de entorno en Railway:

| Variable | Descripción |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo de la cuenta de servicio de Firebase |
| `SHOPIFY_WEBHOOK_SECRET` | Secret del webhook de Shopify |
| `PORT` | Asignado automáticamente por Railway |

## Endpoints:

- `GET /` — Health check
- `POST /crear-checkout` — Genera link de pago Shopify
- `POST /webhook/shopify` — Recibe y procesa pagos de Shopify

## Flujo:
1. Socio da clic en "Suscribirme" en el portal
2. Portal llama a `/crear-checkout` → recibe URL de Shopify
3. Socio paga en Shopify
4. Shopify dispara `orders/paid` a `/webhook/shopify`
5. Servidor crea/activa al miembro en Firebase Firestore
6. Socio entra al portal con su email y contraseña
