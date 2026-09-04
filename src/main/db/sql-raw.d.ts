// Los .sql se embeben en el bundle con el sufijo `?raw` de Vite: el DDL sigue
// viviendo en ficheros .sql (02-esquema-bd.md §1) y a la vez viaja dentro del
// paquete de la app, donde no hay `migrations/` que leer del disco.
declare module '*.sql?raw' {
  const content: string
  export default content
}
