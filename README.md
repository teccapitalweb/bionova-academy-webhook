# BioNova VIP · Webhook

Backend Stripe + cron NewsData para la plataforma VIP de BioNova
(biomedicina, microbiología y medicina general). Desplegado en **Railway**.

Misma arquitectura modular que IMDIIL/OdonTeck. La cuenta de Stripe es
**compartida** con otras plataformas, por eso el webhook filtra por
`metadata.source === 'bionova'` y **ignora** pagos de otros proyectos.

## Estructura
```
config/    env, firebase, stripe
services/  stripe, firestore, email, news
routes/    stripe, membership, admin, news, health
index.js   entry point
```

## Endpoints
- `POST /stripe/webhook` — eventos Stripe (raw body + firma)
- `POST /stripe/checkout` — Embedded Checkout con cupones (`allow_promotion_codes`)
- `GET  /stripe/session/:id` — estado de la sesión
- `POST /stripe/cancel-subscription` — cancela al fin de periodo (conserva acceso)
- `POST /stripe/reactivate-subscription` — revierte la cancelación
- `POST /stripe/create-billing-portal` — portal de facturación
- `GET  /membership/:uid` — paywall del panel
- `POST /admin/activar-manual` — activa Mensual/Anual o regala días (admin)
- `POST /admin/cancelar-stripe` — cancela suscripción (admin)
- `POST /admin/eliminar-miembro` — borra Stripe + Firestore + Auth (admin, a prueba de balas)
- `GET  /noticias/sync?secret=` — dispara el cron manualmente
- `GET  /test-correo?to=` — prueba el correo sin gastar pagos
- `GET  /health` — health check

## Deploy en Railway
1. Conecta el repo `teccapitalweb/bionova-academy-webhook` a Railway.
2. En **Settings → Variables**, agrega las de `.env.example` (valores reales).
3. **Redeploy** después de cambiar variables (Railway solo las carga al redesplegar).
4. Copia la URL pública (algo como `https://bionova-academy-webhook-production.up.railway.app`).
5. Pon esa URL en `vip-panel.html` y `vip-admin.html` (la MISMA en ambos).

## Webhook de Stripe
1. Stripe → Developers → Webhooks → **Add endpoint**.
2. URL: `https://<tu-railway>.up.railway.app/stripe/webhook`
3. Eventos: `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`.
4. Copia el **Signing secret** (`whsec_...`) a `STRIPE_WEBHOOK_SECRET` en Railway → Redeploy.

## Notas
- **Cancelar** = `cancel_at_period_end:true`: deja de cobrar pero conserva acceso
  hasta fin de periodo. En Stripe sigue "Active · Cancels on [fecha]" (no es bug).
- **Cupón ≠ Código promocional**: crea ambos en Stripe y lígalos; el checkout ya
  manda `allow_promotion_codes:true`.
- **Regalo / activación manual** = mismos permisos que VIP de paga; difiere solo lo interno.
