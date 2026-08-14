# Pipeline live gate — GO FOR IT

Dry-run is the **default** for all Airbnb `send_message` jobs. Leaving dry-run
on requires no action. Turning it off is one phrase — equally easy.

## Arm (go fully live)

Say or type the exact phrase:

```text
GO FOR IT
```

Those three words, that capitalization (API `phrase=`). Spoken STT may match
the same three words case-insensitively so voice still works.

What happens:

1. Jarvis (`cortex_session` / `main.py`) or `luxe_supabase` action `arm_live` with
   `phrase=GO FOR IT` writes `Jarvis-cortex/config/pipeline_live.armed` **and**
   mirrors `settings.pipeline_live` in Supabase so the VM worker shares the gate.
2. `send_message` can then leave dry-run **only when** the same request also
   sets `confirm_send=true`.
3. Worker also refuses live sends unless `LUXE_PIPELINE_LIVE=1` **or**
   `settings.pipeline_live.armed` is true.
4. Ops alternative (rare, scripted): `LUXE_PIPELINE_LIVE=1` in the process env
   (still prefer the spoken phrase).

## Disarm (back to dry-run)

As easy as arming — no special phrase:

- Ask Jarvis to disarm, or call `luxe_supabase` action `disarm_live`
- Or delete `Jarvis-cortex/config/pipeline_live.armed`
- Or set `LUXE_PIPELINE_LIVE=0`

## Never invent the phrase

Models must not invent `GO FOR IT`. If the user did not say it, keep dry-run.

## Smoke / verification (safe)

```bash
python3 scripts/jarvis_wire_check.py
python3 scripts/pipeline_smoke.py          # dry-run only; never arms live
python3 scripts/pipeline_audit.py          # refreshes scripts/audit-output.json
```

Bootstrap session (Chrome closed; do not paste secrets):

```bash
python3 scripts/airbnb_cookie_push.py
```

If `~/.ssh/config` Host `luxe-vm` fails with `ServerAlive` parse error, fix
`ServerAliveInterval` or:

```bash
SSH_OPTS='-F /dev/null -i ~/.ssh/jarvis-key.pem' \
VM_HOST=ec2-user@18.116.200.10 LEGACY_HOME=1 ./deploy/install-vm.sh
```
