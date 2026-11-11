/**
 * The FFI surface the Windows computer host needs, on `bun:ffi`.
 *
 * The host was written against `Deno.dlopen`: symbol tables of
 * `{ parameters, result }`, pointer values, `UnsafeCallback` and
 * `UnsafePointerView`. This module keeps that shape — and Deno's type
 * mapping, so the Win32 declarations stay readable — while the calls go to
 * Bun's FFI, whose symbol tables are `{ args, returns }` with `FFIType`
 * numbers and whose pointers are plain numbers.
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

/** Deno's native type names, mapped to Bun's FFI types. */
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

/** Bun's FFI passes pointers as numbers (`null` for a null pointer, which
 * Deno spells the same way). */
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
          ? // `undefined` rather than `void`: a function returning undefined
            // is assignable where a void-returning one is expected, and the
            // type is not in a return position here.
            undefined
          : number;

export interface ForeignFunction {
  readonly parameters: readonly NativeType[];
  readonly result: NativeType;
}

export type ForeignLibraryInterface = Record<string, ForeignFunction>;

type NativeArgs<P extends readonly NativeType[]> = {
  [K in keyof P]: P[K] extends NativeType ? ToNative<P[K]> : P[K];
};

type StaticForeignSymbol<F extends ForeignFunction> = (
  ...args: NativeArgs<F["parameters"]>
) => ToNative<F["result"]>;

export interface DynamicLibrary<S extends ForeignLibraryInterface> {
  readonly symbols: { readonly [K in keyof S]: StaticForeignSymbol<S[K]> };
  close(): void;
}

/** `Deno.dlopen`: open a library and adapt each Deno-style symbol entry. */
export function dlopen<S extends ForeignLibraryInterface>(
  path: string,
  symbols: S,
): DynamicLibrary<S> {
  const table: Record<string, { args: number[]; returns: number }> = {};
  for (const [name, symbol] of Object.entries(symbols)) {
    table[name] = {
      args: symbol.parameters.map((type) => FFI_TYPES[type]),
      returns: FFI_TYPES[symbol.result],
    };
  }
  return bunDlopen(path, table) as unknown as DynamicLibrary<S>;
}

/** `Deno.UnsafePointer`. */
export const UnsafePointer = {
  create: (value: bigint | number): PointerValue => Number(value),
  value: (pointer: NonNullable<PointerValue>): bigint => BigInt(pointer),
  equals: (a: PointerValue, b: PointerValue): boolean => a === b,
};

/** `Deno.UnsafePointerView`: read C memory through a pointer. */
export class UnsafePointerView {
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

/** `Deno.UnsafeCallback`: a JS function the native side can call. The
 * callback must be closed by its owner (`close()`), which the host does after
 * the enumeration it was passed to returns. */
export class UnsafeCallback {
  readonly callback: JSCallback;

  constructor(
    definition: ForeignFunction,
    fn: (...args: PointerValue[]) => number,
  ) {
    this.callback = new JSCallback(fn as (...args: never[]) => number, {
      args: definition.parameters.map((type) => FFI_TYPES[type]),
      returns: FFI_TYPES[definition.result],
    });
  }

  get pointer(): PointerValue {
    return this.callback.ptr;
  }

  close(): void {
    this.callback.close();
  }
}
