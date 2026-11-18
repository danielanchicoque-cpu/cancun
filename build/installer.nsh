; Al actualizar, cierra Cancun si está abierto (antes el instalador fallaba con "el
; programa sigue abierto"). Los proyectos se guardan solos, no se pierde trabajo.
!macro customInit
  nsExec::Exec `taskkill /IM "Cancun.exe" /T /F`
  Sleep 1500
!macroend

!macro customUnInit
  nsExec::Exec `taskkill /IM "Cancun.exe" /T /F`
  Sleep 1000
!macroend
