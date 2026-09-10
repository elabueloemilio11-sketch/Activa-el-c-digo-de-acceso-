# API contract

Todas las respuestas JSON usan `ok: boolean`. Los errores de credenciales muestran mensajes genéricos para evitar enumeración.

## Activación

### `POST /api/access/validate`

```json
{ "code": "AE-XXXX-XXXX-XXXX" }
```

Respuesta válida: `{ "ok": true, "next": "email" }` y cookie corta `HttpOnly`.

### `POST /api/access/verify-email`

```json
{ "email": "buyer@example.com" }
```

Dispositivo existente: `next=academy`. Dispositivo nuevo: `next=otp`.

### `POST /api/access/verify-otp`

```json
{ "otp": "123456" }
```

Éxito: crea token de dispositivo + sesión. Límite alcanzado: HTTP 409 y `code=DEVICE_LIMIT`.

### `POST /api/access/otp`

Reenvío sujeto a cooldown y rate limiting.

## Dispositivos

`GET /api/devices` acepta una sesión normal o un reto de sustitución ya verificado por OTP.

`POST /api/device/revoke` exige header `X-CSRF-Token` con el valor de la cookie CSRF.

```json
{ "deviceId": "uuid" }
```

En modo sustitución revoca el dispositivo elegido, crea el nuevo y abre la sesión en una única transacción.

## Recuperación

- `POST /api/access/recover` — siempre devuelve el mismo mensaje público.
- `POST /api/access/recover/confirm` — consume el token de un solo uso, rota el código y revoca todo lo anterior.

El token se entrega en el fragmento `#token=...`, por lo que no aparece en logs HTTP ni en `Referer`.

## Admin

- `POST /api/admin/login`
- `GET /api/admin/accesses?q=`
- `GET /api/admin/access/:id`
- `POST /api/admin/access/:id/action`

Acciones: `revoke_device`, `revoke_all_devices`, `disable_access`, `reactivate_access`, `mark_suspicious`, `clear_suspicious`, `set_device_limit`.

Los hashes, cifrados y tokens nunca se devuelven por API.
