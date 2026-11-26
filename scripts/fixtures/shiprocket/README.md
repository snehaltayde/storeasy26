Shiprocket fixtures (Phase 9 line 4). Shapes follow Shiprocket's external API
(apiv2.shiprocket.in/v1/external, docs read 2026-11-26): auth/login,
courier/serviceability, courier/track/awb/{awb}, and the tracking webhook
body. `__AWB__` is replaced with the asked AWB. lib/couriers/stub.js serves
these outside production only; nothing here calls the real API.
