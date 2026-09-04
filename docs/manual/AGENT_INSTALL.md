# Instalar Orbix con un agente

Para cuando prefieres que un agente (Claude Code u otro con acceso a terminal) instale Orbix por ti en vez de hacerlo a mano. Copia el bloque de abajo entero y pégaselo como primer mensaje.

El propio prompt le dice al agente **hasta dónde puede llegar solo** y **dónde tiene que pararse y avisarte**: puede instalar, arrancar y comprobar que todo funciona por su cuenta, pero el último paso — conectar Orbix con Claude Code de verdad — modifica tu `~/.claude/settings.json`, y eso lo tienes que confirmar tú mismo desde la propia app. No es una limitación del agente: es un candado deliberado de Orbix, para que ese fichero nunca lo toque nadie sin que tú lo veas y lo aceptes.

---

## El prompt

```
Instala Orbix, una app de escritorio para macOS que acompaña a Claude Code
(repositorio: https://github.com/elrincondeisma/orbix). Sigue estos pasos en
orden y comprueba cada uno antes de pasar al siguiente. Si algo falla, para
y explícame qué ha pasado en vez de intentar rodearlo.

1. REQUISITOS
   - `sw_vers -productVersion` debe ser 13.0 o superior.
   - `uname -m` debe ser `arm64` (Apple Silicon). Si es `x86_64`, para aquí:
     Orbix todavía no tiene build para Intel.
   - Comprueba que Claude Code está instalado (`command -v claude` o busca en
     `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`).
     Si no lo encuentras, avísame antes de continuar: Orbix no sirve de nada
     sin Claude Code.

2. INSTALACIÓN
   Si `command -v brew` existe, instala así:
     brew tap elrincondeisma/orbix
     brew install --cask elrincondeisma/orbix/orbix

   Si no hay Homebrew, NO lo instales por tu cuenta — usa el DMG directamente.
   El nombre del fichero lleva la versión, así que resuelve la URL real vía
   la API de GitHub en vez de adivinarla:
     DMG_URL=$(curl -fsSL https://api.github.com/repos/elrincondeisma/orbix/releases/latest \
       | grep browser_download_url | grep '\.dmg' | cut -d '"' -f 4)
     curl -fsSL -o /tmp/orbix.dmg "$DMG_URL"
     MOUNT=$(hdiutil attach /tmp/orbix.dmg -nobrowse | tail -1 | awk -F'\t' '{print $NF}')
     ditto "$MOUNT/Orbix.app" /Applications/Orbix.app
     hdiutil detach "$MOUNT" -quiet
     xattr -dr com.apple.quarantine /Applications/Orbix.app

   (Orbix no está firmado con un certificado de Apple Developer ID todavía.
   Como tú lo estás instalando por terminal y no descargándolo a mano en un
   navegador, quitar la cuarentena aquí es seguro y esperable — es
   exactamente lo que hace `brew install --cask` por su cuenta.)

3. ARRANQUE Y VERIFICACIÓN
     open -a Orbix
   Espera unos segundos y comprueba que responde:
     curl -s http://127.0.0.1:41414/health
   Debe devolver un JSON con "app":"Orbix" y "ready":true. Si no responde en
   10-15 segundos, algo ha ido mal — dímelo con lo que hayas visto, no lo
   reintentes en bucle.

4. CONECTAR CON CLAUDE CODE — este paso NO lo hagas tú, avísame
   Orbix ya está instalado y contando tokens en segundo plano en cuanto
   arranca (lee los transcripts de ~/.claude/projects). Pero para que la
   mascota reaccione en tiempo real a lo que hace Claude Code, hace falta
   instalar un hook, y eso modifica ~/.claude/settings.json — un fichero que
   no debes tocar tú directamente ni pedirme que lo edite a mano.

   En vez de eso, dime literalmente esto y para ahí:

   "Orbix está instalado y funcionando. Para que reaccione a Claude Code,
   abre el icono de Orbix en la barra de menús → Preferencias →
   Integración → Instalar. Ahí verás exactamente qué hooks tienes ya
   configurados (se conservan todos) y qué va a añadir Orbix, antes de que
   confirmes nada."

   No intentes instalar el hook por tu cuenta modificando settings.json ni
   llamando a la app por otra vía: es una decisión que tiene que tomar la
   persona, viendo la pantalla real de confirmación.

5. RESUMEN FINAL
   Dime en dos líneas: si se instaló por Homebrew o por DMG, si el servidor
   respondió sano, y recuérdame el paso 4 si todavía no lo he hecho.
```

---

## Por qué está diseñado así

- **Todo lo mecánico, automatizado.** Comprobar requisitos, instalar, arrancar, verificar que el servidor responde: nada de eso necesita que decidas tú, así que el agente lo hace solo.
- **Lo que toca tu configuración, no.** El instalador de hooks vive detrás de una pantalla de Preferencias que te enseña exactamente qué va a cambiar antes de tocar nada — el mismo candado que protege a cualquiera que instale Orbix a mano. Un agente con acceso a terminal *podría* técnicamente saltárselo, y este prompt le pide explícitamente que no lo haga.
- **Sin quitar la cuarentena a ciegas.** El paso de instalación por DMG solo quita el atributo de cuarentena porque es el propio agente, actuando por ti, quien lo ha descargado — no un archivo que alguien más te haya mandado.
