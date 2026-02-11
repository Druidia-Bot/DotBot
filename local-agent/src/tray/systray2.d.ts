declare module "systray2" {
  interface MenuItem {
    title: string;
    tooltip: string;
    checked: boolean;
    enabled: boolean;
  }

  interface MenuConfig {
    icon: string;
    title: string;
    tooltip: string;
    items: MenuItem[];
  }

  interface SysTrayOptions {
    menu: MenuConfig;
    debug?: boolean;
    copyDir?: boolean;
  }

  interface ClickAction {
    seq_id: number;
    title: string;
    checked: boolean;
    enabled: boolean;
  }

  class SysTray {
    constructor(options: SysTrayOptions);
    onClick(cb: (action: ClickAction) => void): void;
    sendAction(action: { type: string; menu?: Partial<MenuConfig>; item?: Partial<MenuItem>; seq_id?: number }): void;
    kill(exitProcess?: boolean): void;
  }

  export default SysTray;
}
