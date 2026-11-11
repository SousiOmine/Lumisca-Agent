/**
 * `@novnc/novnc` ships no type declarations. The only import in the app
 * casts the module to the small `RfbConstructor` shape it uses, so an
 * untyped declaration is enough and keeps the cast as the one place that
 * describes the dependency.
 */
declare module "@novnc/novnc";
