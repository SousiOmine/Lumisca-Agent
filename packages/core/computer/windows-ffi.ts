/**
 * The FFI surface the Windows computer host needs, on \`bun:ffi\`.
 *
 * The host declares Win32 functions as symbol tables: a name, the argument
 * types and the return type. Bun's own tables use \`{ args, returns }\` with
 * \`FFIType\` numbers and plain-number pointers; this module maps the readable
 * type names once, so the declarations in windows.ts stay legible.
 *
 * Nothing here runs off Windows: the module may be imported anywhere, and a
 * library opens only when the host is created.
 *
 * Not verified on a real Windows desktop (the machine this was written on is
 * Linux). The structures and sizes are the ones the host already used; what
 * is new is the bridge, so the first run on Windows should be a monitor
 * enumeration and one screenshot before anything is clicked.
 */
import {
  dlopen as bunDlopen,
  FFIType,
  JSCallback,
  toArrayBuffer,
} from "bun:ffi";

/** Readable native type names, mapped to Bun's FFI types. */
const FFI_TYPES = {
  void: FFIType.void,
  bool: FFIType.bool,
  u8: FFIType.u8,
  i8: FFIType.i8,
  u16: FFIType.u16,
  i16: FFIType.i16,
  u32: FFIType.u32,
  i32: FFIType.i32,
  u64: FFIType.u64,
  i64: FFIType.i64,
  usize: FFIType.usize,
  isize: FFIType.isize,
  f32: FFIType.f32,
  f64: FFIType.f64,
  pointer: FFIType.ptr,
  /** A pointer a typed array may be passed to. */
  buffer: FFIType.ptr,
} as const;

export type NativeType = keyof typeof FFI_TYPES;

/** Bun's FFI passes pointers as numbers (\`null\` for a null pointer). */
export type PointerValue = number | null;

type ToNative<T extends NativeType> = T extends "pointer"
  ? PointerValue
  : T extends "buffer"
    ? BufferSource
    : T extends "bool"
      ? boolean
      : T extends "u64" | "i64" | "usize" | "isize"
        ? bigint
        : T extends "void"
          ? // \`undefined\` rather than \`void\`: a function returning undefined
            // is assignable where a void-returning one is expected, and the
            // type is not in a return position here.
            undefined
          : number;

export interface FfiFunction {
  readonly args: readonly NativeType[];
  readonly returns: NativeType;
}

export type FfiLibrary = Record<string, FfiFunction>;

type NativeArgs<P extends readonly NativeType[]> = {
  [K in keyof P]: P[K] extends NativeType ? ToNative<P[K]> : P[K];
};

type StaticForeignSymbol<F extends FfiFunction> = (
  ...args: NativeArgs<F["args"]>
) => ToNative<F["returns"]>;

export interface NativeLibrary<S extends FfiLibrary> {
  readonly symbols: { readonly [K in keyof S]: StaticForeignSymbol<S[K]> };
  close(): void;
}

/** Open a library and adapt each readable symbol entry to Bun's table. */
export function dlopen<S extends FfiLibrary>(
  path: string,
  symbols: S,
): NativeLibrary<S> {
  const table: Record<string, { args: number[]; returns: number }> = {};
  for (const [name, symbol] of Object.entries(symbols)) {
    table[name] = {
      args: symbol.args.map((type) => FFI_TYPES[type]),
      returns: FFI_TYPES[symbol.returns],
    };
  }
  return bunDlopen(path, table) as unknown as NativeLibrary<S>;
}

/** A pointer as a value the host can compare and print. */
export const Pointer = {
  from: (value: bigint | number): PointerValue => Number(value),
  toBigInt: (pointer: NonNullable<PointerValue>): bigint => BigInt(pointer),
  equals: (a: PointerValue, b: PointerValue): boolean => a === b,
};

/** Read C memory through a pointer. */
export class PointerView {
  constructor(private readonly pointer: NonNullable<PointerValue>) {}

  #view(offset: number, size: number): DataView {
    return new DataView(toArrayBuffer(this.pointer + offset, 0, size));
  }

  getInt32(offset: number): number {
    return this.#view(offset, 4).getInt32(0, true);
  }

  getUint32(offset: number): number {
    return this.#view(offset, 4).getUint32(0, true);
  }

  getBigInt64(offset: number): bigint {
    return this.#view(offset, 8).getBigInt64(0, true);
  }
}

/** A JS function the native side can call. The callback must be closed by
 * its owner (\`close()\`), which the host does after the enumeration it was
 * passed to returns. */
export class NativeCallback {
  readonly callback: JSCallback;

  constructor(
    definition: FfiFunction,
    fn: (...args: PointerValue[]) => number,
  ) {
    this.callback = new JSCallback(fn as (...args: never[]) => number, {
      args: definition.args.map((type) => FFI_TYPES[type]),
      returns: FFI_TYPES[definition.returns],
    });
  }

  get pointer(): PointerValue {
    return this.callback.ptr;
  }

  close(): void {
    this.callback.close();
  }
}
