/** Vite resuelve las imágenes importadas a una URL con hash y las copia a `out/`. */
declare module '*.png' {
  const url: string
  export default url
}
