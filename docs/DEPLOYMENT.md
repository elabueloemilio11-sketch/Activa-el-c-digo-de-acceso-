# Deploy de producción

## 1. GitHub

El repositorio debe contener `render.yaml` en la raíz y usar la rama `main`. No subas `.env` ni ningún token.

## 2. Crear el Blueprint Render

Usa el Blueprint del repositorio. Crea:

- `abuelo-emilio-academy-access` — web service Node;
- `abuelo-emilio-academy-db` — PostgreSQL;
- conexión `DATABASE_URL` automática;
- ejecución de migraciones antes de cada deploy.

Antes de aplicar, completa las variables marcadas como secretas:

| Variable | Valor esperado |
|---|---|
| `APP_URL` | URL HTTPS final, sin `/` al final |
| `SHOPIFY_WEBHOOK_SECRET` | secreto de firma de la app/webhook Shopify |
| `EMAIL_FROM` | remitente verificado, por ejemplo `Abuelo Emilio Academy <acceso@dominio.com>` |
| `EMAIL_API_KEY` | API key Resend si `EMAIL_PROVIDER=resend` |
| `ADMIN_PASSWORD` | contraseña única de al menos 16 caracteres |

`SESSION_SECRET`, `CODE_PEPPER` y `CODE_ENCRYPTION_KEY` se generan una sola vez por Render.

## 3. Email

Configuración predeterminada: Resend.

```dotenv
EMAIL_PROVIDER=resend
EMAIL_FROM=Abuelo Emilio Academy <acceso@tu-dominio.com>
EMAIL_API_KEY=re_...
```

Para SMTP:

```dotenv
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASSWORD=...
```

No uses `console` en producción; el servidor se negará a iniciar.

## 4. Shopify

Configura la tienda y la variante autorizada:

```dotenv
SHOPIFY_STORE_DOMAIN=academiaemilio.myshopify.com
SHOPIFY_PRODUCT_VARIANT_IDS=63469093847370
SHOPIFY_CHECKOUT_URL=https://academiaemilio.myshopify.com/cart/63469093847370:1
SHOPIFY_API_VERSION=2026-07
```

Con la app ya desplegada y sus variables activas:

```bash
npm run register:webhooks
```

El script consulta suscripciones existentes y crea solo la que falte. Para usarlo localmente, define también `SHOPIFY_ADMIN_ACCESS_TOKEN`:

- `ORDERS_PAID` → `${APP_URL}/webhooks/shopify/order-paid`

## 5. Shopify theme

En el editor de la plantilla unpublished, selecciona el botón `OBTENER` y fija el enlace a:

```text
https://TU-DOMINIO/access
```

El botón de compra dentro de `/access` ya apunta al permalink de checkout de la variante correcta.

## 6. Verificación antes de abrir ventas

1. `GET /health` devuelve `{"status":"ok"}`.
2. Una compra real genera exactamente una fila de acceso y un email.
3. Reenviar el mismo webhook no crea un segundo código.
4. Código + email incorrecto devuelve el mensaje genérico.
5. El primer y segundo dispositivo requieren OTP.
6. El tercero exige revocar uno anterior.
7. Solo existen 2 sesiones activas.
8. `/admin` permite localizar el pedido, desactivar manualmente un acceso reembolsado y revisar el audit log.

## 7. Operación

- No cambies los tres secretos criptográficos una vez emitidas licencias.
- Conserva backups de PostgreSQL adecuados al volumen de ventas.
- Revisa cuentas `suspicious`; el sistema no bloquea automáticamente por cambio de IP.
- Comprueba la cola `email_outbox` si un comprador no recibe el código.
- Tras un reembolso manual en Shopify, busca el `order_id` o email en `/admin` y usa `Desactivar acceso`.
- Usa un dominio propio y HTTPS antes de producción.
