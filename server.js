const express = require('express');
const crypto  = require('crypto');
const admin   = require('firebase-admin');

const app = express();

// ══ FIREBASE ADMIN INIT ══════════════════════════════════════════════
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db   = admin.firestore();
const auth = admin.auth();

// ══ MIDDLEWARE ════════════════════════════════════════════════════════
// Necesitamos el raw body para verificar la firma de Shopify
app.use('/webhook/shopify', express.raw({ type: 'application/json' }));
app.use(express.json());

// ══ HEALTH CHECK ═════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'BIONOVA Academy Webhook',
    timestamp: new Date().toISOString()
  });
});

// ══ CREAR CHECKOUT SHOPIFY ════════════════════════════════════════════
// El portal lo llama para generar el link de pago
app.post('/crear-checkout', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { variantId, email } = req.body;
    if (!variantId) {
      return res.status(400).json({ error: 'variantId requerido' });
    }

    const shopifyStore = 'pfueck-wm.myshopify.com';
    const storefrontToken = '4c5d8f6909eccf2964cbb97e0ee2187e';

    // Cart API (checkoutCreate fue deprecated en 2024)
    const buyerIdentity = email ? `, buyerIdentity: { email: "${email}" }` : '';
    const query = `
      mutation {
        cartCreate(input: {
          lines: [{ merchandiseId: "gid://shopify/ProductVariant/${variantId}", quantity: 1 }]
          ${buyerIdentity}
        }) {
          cart { checkoutUrl }
          userErrors { message }
        }
      }`;

    const response = await fetch(`https://${shopifyStore}/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': storefrontToken
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();
    const checkoutUrl = data?.data?.cartCreate?.cart?.checkoutUrl;
    const errors      = data?.data?.cartCreate?.userErrors;

    if (errors && errors.length > 0) {
      console.error('Cart API errors:', errors);
      return res.status(400).json({ error: errors[0].message });
    }
    if (!checkoutUrl) {
      console.error('Cart API raw response:', JSON.stringify(data));
      return res.status(500).json({ error: 'No se pudo generar el checkout', detail: data });
    }

    res.json({ checkoutUrl });

  } catch (err) {
    console.error('Error crear-checkout:', err);
    res.status(500).json({ error: err.message });
  }
});

// OPTIONS para CORS del crear-checkout
app.options('/crear-checkout', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(200);
});

// ══ CANCELAR MEMBRESÍA ════════════════════════════════════════════════
// El socio puede cancelar su suscripción desde el portal
app.post('/cancelar-membresia', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { uid, email, motivo } = req.body;
    if (!uid && !email) {
      return res.status(400).json({ error: 'Se requiere uid o email' });
    }

    // Localizar al miembro en Firestore
    let memberDoc;
    if (uid) {
      memberDoc = await db.collection('miembros').doc(uid).get();
    } else {
      const query = await db.collection('miembros').where('email', '==', email.toLowerCase().trim()).limit(1).get();
      if (!query.empty) memberDoc = query.docs[0];
    }

    if (!memberDoc || !memberDoc.exists) {
      return res.status(404).json({ error: 'Miembro no encontrado' });
    }

    // Actualizar estado a "cancelado" (mantiene acceso hasta que venza)
    await memberDoc.ref.update({
      estado: 'cancelado',
      fechaCancelacion: new Date().toISOString(),
      motivoCancelacion: motivo || 'No especificado',
      renovacionAutomatica: false
    });

    console.log('📋 Membresía cancelada:', memberDoc.data().email, '| Motivo:', motivo || '—');
    res.json({
      success: true,
      message: 'Membresía cancelada. Mantienes acceso hasta tu fecha de vencimiento.',
      vence: memberDoc.data().vence || null
    });

  } catch (err) {
    console.error('❌ Error cancelar-membresia:', err);
    res.status(500).json({ error: err.message });
  }
});

app.options('/cancelar-membresia', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(200);
});

// ══ WEBHOOK SHOPIFY — ORDERS/PAID ════════════════════════════════════
app.post('/webhook/shopify', async (req, res) => {
  try {
    // Verificar firma HMAC de Shopify
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
    const hmac   = req.headers['x-shopify-hmac-sha256'];
    if (secret && hmac) {
      const digest = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('base64');
      if (digest !== hmac) {
        console.warn('Firma inválida — ignorando webhook');
        return res.status(401).json({ error: 'Firma inválida' });
      }
    }

    const order = JSON.parse(req.body.toString());
    const email  = (order.email || '').toLowerCase().trim();
    const nombre = order.billing_address?.first_name || order.customer?.first_name || email.split('@')[0];
    const phone  = order.billing_address?.phone || order.customer?.phone || '';

    if (!email) {
      return res.status(400).json({ error: 'Email no encontrado en el pedido' });
    }

    // Determinar plan según el título del producto
    const lineItem    = order.line_items?.[0];
    const productTitle = (lineItem?.title || '').toLowerCase();
    const plan = productTitle.includes('anual') ? 'PRO Anual' : 'PRO Mensual';

    // Calcular fecha de vencimiento
    const vence = new Date();
    if (plan === 'PRO Anual') {
      vence.setFullYear(vence.getFullYear() + 1);
    } else {
      vence.setMonth(vence.getMonth() + 1);
    }
    const venceStr = vence.toLocaleDateString('es-MX', {
      day: 'numeric', month: 'long', year: 'numeric'
    });

    // Buscar o crear usuario en Firebase Auth
    let uid;
    try {
      const user = await auth.getUserByEmail(email);
      uid = user.uid;
      console.log('Usuario existente activado:', uid, email);
    } catch (e) {
      // Usuario nuevo — crear con contraseña temporal
      const tempPassword = Math.random().toString(36).slice(-8) + 'Bi1!';
      const newUser = await auth.createUser({
        email,
        password: tempPassword,
        displayName: nombre.trim()
      });
      uid = newUser.uid;
      console.log('Usuario nuevo creado:', uid, email);
    }

    // Guardar/actualizar miembro en Firestore
    await db.collection('miembros').doc(uid).set({
      nombre: nombre.trim(),
      email,
      whatsapp: phone,
      plan,
      estado: 'activo',
      vence: venceStr,
      fechaRegistro: new Date().toISOString(),
      shopifyOrderId: String(order.id),
      ultimoPago: new Date().toISOString()
    }, { merge: true });

    console.log('✅ Miembro activado:', email, plan, venceStr);
    res.status(200).json({ success: true, message: 'Miembro activado', email, plan });

  } catch (err) {
    console.error('❌ Error webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══ SERVIDOR ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔬 BIONOVA Academy Webhook corriendo en puerto ${PORT}`);
});
