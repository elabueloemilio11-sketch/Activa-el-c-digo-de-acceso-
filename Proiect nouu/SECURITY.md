# Security policy

## Principios

- No registrar códigos, OTP, tokens, cookies, contraseñas o firmas HMAC.
- No incluir secretos en Git, screenshots, tickets o mensajes.
- No usar IP como bloqueo único; solo es una señal hasheada de riesgo.
- No añadir fingerprinting invasivo.
- No exponer `/academy` ni sus assets sin verificar sesión + dispositivo.

## Secretos

`SESSION_SECRET`, `CODE_PEPPER` y `CODE_ENCRYPTION_KEY` deben ser distintos, aleatorios y de al menos 32 caracteres. Cambiarlos tiene impacto operativo:

- `SESSION_SECRET`: invalida sesiones, tokens de dispositivo y retos.
- `CODE_PEPPER`: invalida lookups de códigos y hashes de IP.
- `CODE_ENCRYPTION_KEY`: impide descifrar emails pendientes.

## Respuesta a incidentes

1. Desactiva la licencia o revoca todos los dispositivos desde `/admin`.
2. Revisa `security_events` y `audit_logs`.
3. Si un código se filtró, usa recuperación verificada para rotarlo.
4. Si hubo reembolso o chargeback, busca el pedido en `/admin` y desactiva inmediatamente el acceso.
5. Rota las credenciales externas comprometidas y vuelve a registrar el webhook si cambia el secreto.

## Reportes

Trata cualquier sospecha de exposición de tokens, bypass de HMAC o acceso a otro comprador como crítica. No incluyas credenciales reales en el reporte.
