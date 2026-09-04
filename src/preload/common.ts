/**
 * miniClaudio — helper tipado de `contextBridge`.
 * Fuente de verdad: docs/design/01-arquitectura.md §3.1.
 *
 * Las cuatro ventanas corren con `sandbox: true`, `contextIsolation: true` y
 * `nodeIntegration: false`. Este módulo es la única puerta entre el renderer y
 * `main`, y no lleva ninguna lógica: solo transporte y lista blanca.
 *
 * Cada preload declara qué canales puede usar SU ventana. Todo lo demás se rechaza
 * en caliente con un `IpcResult` de error, nunca con una excepción cruda.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  MiniClaudioBridge,
  PushChannel,
  PushPayload
} from '@shared/ipc'
import type { IpcResult } from '@shared/types'

function denied<T>(channel: string): IpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'BAD_INPUT',
      message: 'Canal no disponible en esta ventana',
      detail: channel
    }
  }
}

/**
 * Expone `window.miniClaudio` con la superficie mínima de esta ventana.
 *
 * @param invokeChannels canales `invoke` permitidos (renderer → main)
 * @param pushChannels   canales `push` permitidos (main → renderer)
 */
export function exposeBridge(
  invokeChannels: readonly InvokeChannel[],
  pushChannels: readonly PushChannel[]
): void {
  const allowedInvoke = new Set<string>(invokeChannels)
  const allowedPush = new Set<string>(pushChannels)

  const bridge: MiniClaudioBridge = {
    invoke<C extends InvokeChannel>(
      channel: C,
      request: InvokeRequest<C>
    ): Promise<IpcResult<InvokeResponse<C>>> {
      if (!allowedInvoke.has(channel)) {
        return Promise.resolve(denied<InvokeResponse<C>>(channel))
      }
      return ipcRenderer.invoke(channel, request) as Promise<IpcResult<InvokeResponse<C>>>
    },

    on<C extends PushChannel>(channel: C, cb: (payload: PushPayload<C>) => void): () => void {
      if (!allowedPush.has(channel)) return (): void => {}

      const listener = (_event: IpcRendererEvent, payload: unknown): void => {
        cb(payload as PushPayload<C>)
      }
      ipcRenderer.on(channel, listener)
      return (): void => {
        ipcRenderer.removeListener(channel, listener)
      }
    }
  }

  contextBridge.exposeInMainWorld('miniClaudio', bridge)
}
