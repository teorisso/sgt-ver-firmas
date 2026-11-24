# SGT · Ver firmas

Extensión de escritorio para el **Sistema de Gestión de Trámites de Chaco**. Verifica las firmas digitales de **Documentación Adjunta** y **e-Partes**, y permite descargar un ZIP con los títulos de las e-Partes. Proyecto independiente.

**Probada en Windows con Brave, Google Chrome y Microsoft Edge.** Los tres usan el mismo paquete Manifest V3. En otros navegadores de escritorio basados en Chromium, la compatibilidad depende del soporte de extensiones y del visor PDF.

## Instalación

1. Descargá el ZIP de la extensión y extraelo en una carpeta que puedas conservar. [Versiones publicadas en GitHub](https://github.com/teorisso/sgt-ver-firmas/releases/latest)
2. Abrí `brave://extensions` en Brave, `chrome://extensions` en Chrome o `edge://extensions` en Edge.
3. Activá **Modo desarrollador**, elegí **Cargar descomprimida** y seleccioná la carpeta extraída que contiene `manifest.json`. Recargá la pestaña del SGT.

Para un grupo chico, compartí el enlace a **Releases**. Las actualizaciones son manuales. Extraé el ZIP nuevo sobre la instalación anterior, pulsá **Recargar** en la tarjeta de la extensión y actualizá la pestaña del SGT. El panel muestra la versión al pie. Si la oficina administra los equipos y restringe el modo desarrollador, coordiná la distribución con su área de sistemas.

## Uso

- **Documentación Adjunta**. Abrí el PDF de la empresa con la lupa, incluso si figura como **Pendiente**, y elegí **Ver firmas** en el visor. También podés usar el icono de la extensión con el PDF abierto.
- **e-Partes**. Pulsá **Ver firmas** junto a la lupa de la fila. Si se abre la vista previa sin el panel, pulsá **Ver firmas** junto a **Volver**. El panel muestra las firmas del PDF incorporado. Para verificar el archivo que presentó la empresa, usá **Documentación Adjunta**.

La verificación usa la sesión activa, una petición al mismo origen con `no-store` y memoria local. No guarda archivos, URLs temporales ni datos de firmantes. Al abrir la vista previa desde una fila de e-Partes, conserva los números del trámite y de e-Parte en memoria hasta confirmar la pantalla de destino o por un máximo de 25 segundos. La huella SHA-256 se calcula en memoria y solo aparece en el panel del PDF leído.

### Descargar e-Partes con sus títulos

En **e-Partes**, pulsá **Descargar ZIP con títulos** y esperá a que se inicie la descarga. El navegador guarda un solo ZIP. Los PDFs quedan en su raíz, con nombres como `03 - Certificado de obra.pdf`.

La extensión usa la descarga nativa del SGT en memoria, consulta los títulos en la grilla y recorre sus páginas si hace falta. Comprueba el trámite, el identificador interno y el número de cada e-Parte. Si faltan títulos, quitá los filtros de la grilla y volvé a intentarlo. El ZIP incluye las e-Partes de la descarga del SGT, que excluye borradores. El procesamiento es local, preserva los bytes de cada PDF y admite hasta 512 MiB de contenido.

## Qué verifica

- **Integridad** de la revisión firmada, incluidas firmas invisibles. El panel señala si hay bytes posteriores. Pueden corresponder a otra firma o a evidencia de validación.
- **Confianza** de la cadena X.509 contra las raíces argentinas incluidas. Usa la fecha de un sello confirmado cuando está disponible y la fecha de consulta en los demás casos.
- **Revocación** con CRL completas vigentes u OCSP incorporado y autenticado. **Sello de tiempo** con RFC 3161, cadena de la TSA y evidencia de revocación aplicable. El panel muestra **No se pudo comprobar** cuando falta evidencia utilizable.

Compatibilidad del MVP con `adbe.pkcs7.detached`, `adbe.pkcs7.sha1`, `ETSI.CAdES.detached` y `ETSI.RFC3161`. Los formatos restantes se listan sin validar. También admite revisiones incrementales sobre PDFs linearizados. Límite de 80 MiB por PDF. El indicador de cambios posteriores informa sobre bytes y revisiones. La evaluación de los cambios permitidos por DocMDP queda fuera del MVP.

## Actualizar la cadena

Usá Node.js 24 y corré `npm ci`, `npm run trust:update` y `npm run build`. Luego recargá la extensión en Brave. La actualización descarga certificados y CRL públicos en una operación separada de la verificación. El script comprueba las huellas de las raíces y autentica las firmas de los certificados intermedios y las CRL. Ante una rotación de raíz, verificá la nueva huella por un canal oficial antes de actualizar las raíces aprobadas en `scripts/refresh-trust.mjs`. [AC Raíz de la República Argentina](https://www.argentina.gob.ar/jefatura/innovacion-ciencia-y-tecnologia/innovacion/firma-digital/ac-raiz) · [Certificadores licenciados](https://www.argentina.gob.ar/jefatura/innovacion-ciencia-y-tecnologia/innovacion/firma-digital/certificadores-licenciados)

El paquete incluye dos raíces, 20 intermedias y tres CRL públicas correspondientes a ambas raíces y a PFDR. La CRL de ONTI superó el límite de 2 MiB de la actualización. La revocación de esos certificados requiere evidencia incorporada utilizable. Las listas empaquetadas vencen según el `nextUpdate` publicado.

El análisis utiliza [Peculiar PDF Core](https://github.com/PeculiarVentures/pdf), [PKI.js](https://pkijs.org/) y Web Crypto. Los avisos de las bibliotecas están en `dist`.

## Compilar y probar

Con Node.js 24, ejecutá `npm ci` y `npm run build`. La extensión queda en `dist`. En PowerShell, `./scripts/package.ps1` prepara el ZIP y su SHA-256 en `release`.

`npm test` cubre PDFs sin firma, firmas invisibles y múltiples, alteración, confianza, CRL, OCSP, sello de tiempo y renombrado de ZIP. `npm run check` verifica TypeScript. Después de compilar, `npm run test:brave` prueba la verificación de PDFs y la descarga del ZIP renombrado desde una grilla paginada en un perfil descartable. Para otro ejecutable, usá `SGT_BROWSER_PATH`. Google Chrome requiere además `SGT_CDP_LOAD=1` para la carga automatizada en pruebas.

## Licencia

Copyright © 2026 Teo Risso. Licencia [GNU AGPL v3](LICENSE). Cada ZIP incluye los avisos de terceros y un enlace al código de esa versión. El código de Peculiar PDF Core incluido corresponde a [v2.0.1](https://github.com/PeculiarVentures/pdf/tree/v2.0.1).
