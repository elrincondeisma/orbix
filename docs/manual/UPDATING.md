# Actualizar Orbix

Dos guías distintas en un mismo documento: cómo actualiza **quien usa** Orbix su instalación, y cómo publica **quien mantiene** el proyecto una versión nueva.

## Índice

1. [Para quien usa Orbix](#1-para-quien-usa-orbix)
2. [Para quien publica una versión nueva](#2-para-quien-publica-una-versión-nueva)

---

## 1. Para quien usa Orbix

### Instalado con Homebrew

```sh
brew upgrade --cask orbix
```

### Instalado con el DMG

Descarga la última versión desde [Releases](https://github.com/elrincondeisma/orbix/releases) y arrastra `Orbix.app` a `Aplicaciones`, sustituyendo el anterior — igual que la primera instalación. Si macOS avisa de nuevo por no estar firmado, clic derecho → Abrir, como la primera vez.

### Qué sobrevive a la actualización, y qué no

- **Tu histórico y tus preferencias** — viven en `~/Library/Application Support/Orbix`, fuera de `Orbix.app`. Sustituir la app nunca los toca.
- **Los hooks instalados en `~/.claude/settings.json`** — tampoco se tocan. Si una actualización cambia algo del contrato de eventos (raro, y se avisaría en las notas del release), Preferencias → Integración lo señala.
- Tras actualizar, cierra y vuelve a abrir Orbix una vez para que tome la versión nueva del todo.

---

## 2. Para quien publica una versión nueva

Runbook probado paso a paso publicando la v0.1.0. Sigue el orden: cada paso da por hecho que el anterior salió bien.

### 2.1 Sube la versión

```sh
cd ~/Projects/propios/miniClaudio   # el nombre del directorio sigue siendo el antiguo; el proyecto es Orbix
npm version 0.2.0 --no-git-tag-version   # actualiza package.json y package-lock.json, sin crear el tag todavía
```

### 2.2 Verifica antes de empaquetar

```sh
npm test
npm run build
```

Los dos tienen que salir limpios. No sigas si algo falla aquí — es mucho más barato arreglarlo ahora que después de firmar y publicar.

### 2.3 Empaqueta con la firma ad-hoc

```sh
npm run rebuild:electron
npx electron-builder --mac --arm64
```

**No te saltes esto ni lo hagas a mano.** `electron-builder.yml` tiene un hook `afterPack` (`scripts/after-pack.cjs`) que vuelve a firmar el `.app` completo después de empaquetarlo. Sin él, el binario de Electron llega con una firma ad-hoc que solo cubre el ejecutable — `Sealed Resources=none` — y bajo cuarentena real (una descarga de verdad, o `brew install --cask`) macOS no se limita a avisar: **borra la app entera** en el primer arranque. Ocurrió publicando la v0.1.0; quedó documentado en el propio `electron-builder.yml` y en `scripts/after-pack.cjs` para que no vuelva a pasar en silencio.

Verifica que el hook hizo su trabajo — debe aparecer en la salida del build:

```
[after-pack] firmando ad-hoc (consistente) .../release/mac-arm64/Orbix.app
[after-pack] recursos sellados correctamente.
```

Y compruébalo tú también, aparte:

```sh
spctl -a -vv release/mac-arm64/Orbix.app
# esperado: "rejected" (normal para una app sin Developer ID — NO el mensaje
# "code has no resources but signature indicates they must be present",
# que es la firma rota)
codesign -dv release/mac-arm64/Orbix.app 2>&1 | grep "Sealed Resources"
# esperado: algo como "Sealed Resources version=2 rules=13 files=65"
```

### 2.4 Prueba la app empaquetada de verdad

No te fíes solo de que el build terminó sin errores. Instálala y arráncala:

```sh
DMG=release/Orbix-0.2.0-arm64.dmg
MOUNT=$(hdiutil attach "$DMG" -nobrowse | tail -1 | awk -F'\t' '{print $NF}')
ditto "$MOUNT/Orbix.app" /Applications/Orbix.app
hdiutil detach "$MOUNT" -quiet
xattr -dr com.apple.quarantine /Applications/Orbix.app   # ver §2.3: sin esto simulas menos que una instalación real
open -a /Applications/Orbix.app
sleep 4
curl -s http://127.0.0.1:41414/health   # debe responder {"app":"Orbix",...,"ready":true}
```

### 2.5 Tag y release en GitHub

```sh
git add -A
git commit -m "chore: versión 0.2.0"
git tag -a v0.2.0 -m "Orbix 0.2.0"
git push && git push origin v0.2.0

gh release create v0.2.0 \
  release/Orbix-0.2.0-arm64.dmg \
  --repo elrincondeisma/orbix \
  --title "Orbix 0.2.0" \
  --notes "Qué cambia en esta versión, en dos o tres líneas."
```

Verifica que el asset se subió entero, no truncado — descárgalo y compara el checksum contra el original:

```sh
shasum -a 256 release/Orbix-0.2.0-arm64.dmg
curl -sL "https://github.com/elrincondeisma/orbix/releases/download/v0.2.0/Orbix-0.2.0-arm64.dmg" | shasum -a 256
# los dos hashes tienen que coincidir
```

### 2.6 Actualiza el tap de Homebrew

El cask vive en un repo aparte, `elrincondeisma/homebrew-orbix`. Clónalo si no lo tienes a mano:

```sh
git clone git@github.com:elrincondeisma/homebrew-orbix.git /tmp/homebrew-orbix
cd /tmp/homebrew-orbix
```

Edita `Casks/orbix.rb`: cambia `version "0.1.0"` por la nueva, y `sha256` por el hash real del DMG nuevo (el mismo que verificaste en el paso anterior). La URL no hay que tocarla — usa `#{version}` y se resuelve sola.

```sh
git add -A
git commit -m "cask: orbix 0.2.0"
git push
```

### 2.7 Verificación final, de punta a punta

La única prueba que de verdad importa: instalarlo exactamente como lo haría alguien que no ha tocado el proyecto en su vida.

```sh
brew update
brew upgrade --cask orbix   # o `brew install --cask elrincondeisma/orbix/orbix` si es la primera vez en esta máquina
```

Sin warnings de sintaxis del cask, sin que Homebrew se queje del checksum, y la app arrancando sana. Si algo de esto falla, **no lo des por publicado** hasta arreglarlo — es exactamente lo que va a ejecutar cualquiera que instale Orbix desde cero.

### Repaso rápido (para cuando ya te sepas el proceso)

```sh
npm version X.Y.Z --no-git-tag-version
npm test && npm run build
npm run rebuild:electron && npx electron-builder --mac --arm64
spctl -a -vv release/mac-arm64/Orbix.app   # debe decir "rejected", no "no resources"
git add -A && git commit -m "chore: versión X.Y.Z" && git tag -a vX.Y.Z -m "Orbix X.Y.Z"
git push && git push origin vX.Y.Z
gh release create vX.Y.Z release/Orbix-X.Y.Z-arm64.dmg --repo elrincondeisma/orbix --title "Orbix X.Y.Z" --notes "..."
# actualizar version + sha256 en homebrew-orbix/Casks/orbix.rb, commit, push
brew upgrade --cask orbix   # prueba real
```
