# wmux

wmux is a Windows terminal multiplexer organized around workspaces, split panes, and draggable surfaces. This glossary keeps product language precise when discussing layout and terminal interaction behavior.

## Language

**Surface**:
A single terminal, browser, markdown, or diff instance shown as a tab inside a pane. Users drag a surface by grabbing its tab title.
_Avoid_: Console window, terminal window, panel

**Pane**:
A rectangular region in a workspace split tree that contains one or more surfaces.
_Avoid_: Console window, tab

**Live Layout Preview**:
The temporary workspace appearance shown while a surface tab is being dragged, matching the layout that would exist if the surface were dropped at the current target.
_Avoid_: Drop zone highlight, ghost split preview, preshow
