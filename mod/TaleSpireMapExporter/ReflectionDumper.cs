using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEngine;

namespace TaleSpireMapExporter
{
    // Second diagnostic tool for phase 2 (see mod/README.md "Next step" and SceneScanner.cs).
    // The scene scan showed no per-tile/prop GameObjects with predictable names, which means
    // placed board content likely isn't reachable by walking the scene graph at all - it's more
    // likely tracked as data inside a manager component (a candidate: MovableManager, found
    // alongside CreatureManager under SingletonHub in the scan).
    //
    // Instead of opening a decompiler to guess a class's shape, this reflects over a live
    // instance found by type name and prints every field - public, private, and static - with
    // its type and value (or element count, for collections). Plain-object (non-Unity, non-
    // collection) reference-type field values are followed one level in automatically - e.g.
    // BoardSessionManager._board is itself a plain DataModel.Board object, not a Component, so
    // it would otherwise only show up as a bare ToString(). That tells us a class's shape
    // (and its immediate neighbors) without reading any disassembled source.
    internal static class ReflectionDumper
    {
        private const int MaxDepth = 2;

        // Dumps several candidate types in one pass, so narrowing down which manager holds the
        // data of interest doesn't cost a full game restart per guess.
        public static string DumpByTypeNames(IEnumerable<string> simpleTypeNames, Action<string> log)
        {
            var sb = new StringBuilder();
            foreach (var name in simpleTypeNames)
            {
                sb.Append(DumpByTypeName(name.Trim(), log));
                sb.AppendLine();
            }
            return sb.ToString();
        }

        // Finds the first live component whose type's simple name matches, without needing a
        // compile-time reference to that type (it may be internal, or in an assembly this
        // project doesn't want a hard dependency on). Used both by the dump methods below and by
        // BoardExporter to locate singleton managers (e.g. "BoardSessionManager").
        internal static Component FindComponentByTypeName(string simpleTypeName)
        {
            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                if (component.GetType().Name == simpleTypeName) return component;
            }
            return null;
        }

        // Matches by simple type name (not full name) so this works whether the target type is
        // public or internal, and without this project needing a compile-time reference to it.
        public static string DumpByTypeName(string simpleTypeName, Action<string> log)
        {
            var sb = new StringBuilder();
            sb.AppendLine($"# Reflection dump for type '{simpleTypeName}' @ {DateTime.Now:o}");

            var found = false;
            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                var type = component.GetType();
                if (type.Name != simpleTypeName) continue;

                found = true;
                sb.AppendLine();
                sb.AppendLine($"## Instance on GameObject '{component.gameObject.name}' (type {type.FullName})");
                var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);
                visited.Add(component);
                DumpFields(sb, component, type, depth: 0, visited);
            }

            if (!found)
            {
                var msg = $"ReflectionDumper: no live component of type '{simpleTypeName}' found.";
                log(msg);
                sb.AppendLine().AppendLine(msg);
            }

            return sb.ToString();
        }

        // Targeted alternative to the whole-object dump above: navigates a dot-separated chain
        // of field names starting from a live instance of rootSimpleTypeName (e.g.
        // "_board._zones.List[0].InactiveSet.Placeables"), treats the field at the end of the
        // chain as a collection, and dumps the fields of its first maxElements items. Useful once
        // DumpByTypeName has located a promising collection but hit its depth limit before
        // showing what a single element looks like (position, asset id, etc.) - avoids dumping
        // the whole surrounding object graph just to see one element's shape.
        //
        // A path segment may include a "[N]" index (e.g. "List[0]") to pick one element out of an
        // intermediate collection before continuing the chain - needed to get from "all zones" to
        // "the Placeables inside zone 0", for instance.
        public static string PeekCollectionElements(string rootSimpleTypeName, string fieldPath, int maxElements, Action<string> log)
        {
            var sb = new StringBuilder();
            sb.AppendLine($"# Peek '{fieldPath}' on type '{rootSimpleTypeName}' @ {DateTime.Now:o}");

            var found = false;
            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                if (component.GetType().Name != rootSimpleTypeName) continue;
                found = true;

                sb.AppendLine();
                sb.AppendLine($"## {rootSimpleTypeName}.{fieldPath} (on GameObject '{component.gameObject.name}')");

                object current = component;
                var ok = true;
                foreach (var rawSegment in fieldPath.Split('.'))
                {
                    var m = Regex.Match(rawSegment, @"^(\w+)(?:\[(\d+)\])?$");
                    if (!m.Success)
                    {
                        sb.AppendLine($"  <unparseable path segment '{rawSegment}'>");
                        ok = false;
                        break;
                    }

                    var fieldName = m.Groups[1].Value;

                    if (current == null)
                    {
                        sb.AppendLine($"  <chain broke: value became null before reaching '{fieldName}'>");
                        ok = false;
                        break;
                    }

                    var field = FindField(current.GetType(), fieldName);
                    if (field == null)
                    {
                        sb.AppendLine($"  <no field named '{fieldName}' found on {current.GetType().Name}>");
                        ok = false;
                        break;
                    }

                    current = field.GetValue(field.IsStatic ? null : current);

                    if (m.Groups[2].Success)
                    {
                        var index = int.Parse(m.Groups[2].Value);
                        if (current == null || !TryGetElementAt(current, index, out current))
                        {
                            sb.AppendLine($"  <could not read index [{index}] of '{fieldName}' (type {field.FieldType.Name})>");
                            ok = false;
                            break;
                        }
                    }
                }

                if (!ok) continue;

                if (!TryEnumerate(current, out var items))
                {
                    sb.AppendLine($"  <final value is not a (readable) collection via IEnumerable or a Count/Length+indexer guess: {current?.GetType().FullName ?? "null"}>");
                    if (current != null)
                    {
                        sb.AppendLine($"  Listing all members of {current.GetType().FullName} instead, to find its real accessors:");
                        DumpTypeMembers(sb, current.GetType());
                    }
                    continue;
                }

                var i = 0;
                foreach (var item in items)
                {
                    if (i >= maxElements) break;
                    sb.AppendLine();
                    sb.AppendLine($"### element [{i}]");
                    if (item == null)
                    {
                        sb.AppendLine("  null");
                    }
                    else
                    {
                        sb.AppendLine($"  (type {item.GetType().FullName}) {item}");
                        var visited = new HashSet<object>(ReferenceEqualityComparer.Instance) { item };
                        DumpFields(sb, item, item.GetType(), depth: 0, visited);
                    }
                    i++;
                }
            }

            if (!found)
            {
                var msg = $"ReflectionDumper: no live component of type '{rootSimpleTypeName}' found.";
                log(msg);
                sb.AppendLine().AppendLine(msg);
            }

            return sb.ToString();
        }

        // GetField() only searches one type's own declared members even with inherited flags for
        // non-public fields, so this walks the base-class chain by hand. Internal (not private):
        // BoardExporter reuses this to navigate the same DataModel object graph these diagnostic
        // tools found, without re-implementing field lookup.
        internal static FieldInfo FindField(Type type, string name)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Static
                | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

            for (var t = type; t != null; t = t.BaseType)
            {
                var field = t.GetField(name, flags);
                if (field != null) return field;
            }
            return null;
        }

        // Convenience wrapper around FindField for callers that just want a value, not the
        // FieldInfo itself.
        internal static bool TryGetFieldValue(object instance, string fieldName, out object value)
        {
            value = null;
            if (instance == null) return false;

            var field = FindField(instance.GetType(), fieldName);
            if (field == null) return false;

            value = field.GetValue(field.IsStatic ? null : instance);
            return true;
        }

        // Unifies four ways a "collection" shows up in this codebase: plain IList (fast path),
        // plain IEnumerable (walk it), Bounce's unsafe Native* structs that commonly expose a
        // Count/Length property plus an int-indexer but don't implement IEnumerable at all, and
        // (as a last resort) a zero-arg ToArray/AsArray/ToList/AsList conversion method.
        internal static bool TryEnumerate(object value, out IEnumerable<object> items)
        {
            items = null;
            if (value == null) return false;

            if (value is IEnumerable plain)
            {
                items = plain.Cast<object>();
                return true;
            }

            if (TryGetIndexedAccess(value, out var count, out var getter))
            {
                items = EnumerateIndexed(count, getter);
                return true;
            }

            if (TryGetViaConversionMethod(value, out items))
            {
                return true;
            }

            return false;
        }

        private static readonly string[] ConversionMethodNames = { "ToArray", "AsArray", "ToList", "AsList" };

        private static bool TryGetViaConversionMethod(object value, out IEnumerable<object> items)
        {
            var type = value.GetType();
            foreach (var methodName in ConversionMethodNames)
            {
                var method = type.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (method == null) continue;

                try
                {
                    if (method.Invoke(value, null) is IEnumerable result)
                    {
                        items = result.Cast<object>();
                        return true;
                    }
                }
                catch
                {
                    // Try the next candidate method name.
                }
            }

            items = null;
            return false;
        }

        private static IEnumerable<object> EnumerateIndexed(int count, Func<int, object> getter)
        {
            for (var i = 0; i < count; i++) yield return getter(i);
        }

        // Diagnostic fallback for PeekCollectionElements: when a value at the end of a path isn't
        // recognised as a collection, list its public members so its real accessor (an oddly-named
        // count property, a conversion method, etc.) can be spotted without a decompiler.
        private static void DumpTypeMembers(StringBuilder sb, Type type)
        {
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Static
                | BindingFlags.Public | BindingFlags.NonPublic;

            foreach (var prop in type.GetProperties(flags))
            {
                var indexParams = prop.GetIndexParameters();
                var indexSig = indexParams.Length == 0
                    ? ""
                    : "[" + string.Join(", ", indexParams.Select(p => p.ParameterType.Name)) + "]";
                sb.AppendLine($"    property {prop.PropertyType.Name} {prop.Name}{indexSig}");
            }

            foreach (var field in type.GetFields(flags))
            {
                sb.AppendLine($"    field    {field.FieldType.Name} {field.Name}");
            }

            foreach (var method in type.GetMethods(flags))
            {
                if (method.IsSpecialName) continue; // skip property get_/set_ accessors
                var paramSig = string.Join(", ", method.GetParameters().Select(p => p.ParameterType.Name));
                sb.AppendLine($"    method   {method.ReturnType.Name} {method.Name}({paramSig})");
            }
        }

        private static bool TryGetElementAt(object collection, int index, out object element)
        {
            element = null;
            if (collection is IList list)
            {
                if (index < 0 || index >= list.Count) return false;
                element = list[index];
                return true;
            }

            if (!TryEnumerate(collection, out var items)) return false;

            var i = 0;
            foreach (var item in items)
            {
                if (i == index) { element = item; return true; }
                i++;
            }
            return false;
        }

        // Random-access view of an indexer-based collection (count + a getter), for callers like
        // BoardExporter that need to correlate two parallel lists by index rather than just walk
        // one. Same recognition rules as TryEnumerate's indexer path.
        internal static bool TryGetIndexed(object value, out int count, out Func<int, object> getter)
        {
            count = 0;
            getter = null;
            return value != null && TryGetIndexedAccess(value, out count, out getter);
        }

        // Bounce's Native* collections (NativeGreedyList, etc.) are structs wrapping unsafe memory
        // with an int indexer and a count property - but no IEnumerable, so this reads them by
        // (count property + indexer) instead. The count property isn't always called "Count"/
        // "Length": NativeGreedyList<T> exposes its live element count as "ActiveLength" (with
        // "FullLength" as the high-water mark), which is exactly why earlier Count/Length-only
        // attempts to enumerate the per-zone Placeables list came up empty.
        private static bool TryGetIndexedAccess(object value, out int count, out Func<int, object> getter)
        {
            count = 0;
            getter = null;

            var type = value.GetType();
            var countProp = type.GetProperty("Count") ?? type.GetProperty("Length")
                ?? type.GetProperty("ActiveLength") ?? type.GetProperty("FullLength");
            var indexer = type.GetProperty("Item", new[] { typeof(int) });
            if (countProp == null || indexer == null) return false;

            try
            {
                count = (int)Convert.ChangeType(countProp.GetValue(value), typeof(int));
                var capturedValue = value;
                getter = i => indexer.GetValue(capturedValue, new object[] { i });
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void DumpFields(StringBuilder sb, object instance, Type type, int depth, HashSet<object> visited)
        {
            // Includes Static: many Unity singleton/manager classes keep their real registry in
            // a static field (with the MonoBehaviour instance only used for Update()/RPCs), which
            // an instance-only dump would silently miss.
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Static
                | BindingFlags.Public | BindingFlags.NonPublic;

            // Walk up the inheritance chain too - fields declared on base classes don't show up
            // in GetFields() for a derived runtime type otherwise.
            for (var t = type; t != null && t != typeof(UnityEngine.Object); t = t.BaseType)
            {
                foreach (var field in t.GetFields(flags | BindingFlags.DeclaredOnly))
                {
                    DumpOneField(sb, instance, field, t, depth, visited);
                }
            }
        }

        private static void DumpOneField(StringBuilder sb, object instance, FieldInfo field, Type declaringType, int depth, HashSet<object> visited)
        {
            var indent = new string(' ', 2 + depth * 4);
            try
            {
                var value = field.GetValue(instance);
                var staticTag = field.IsStatic ? "static " : "";
                sb.Append($"{indent}{staticTag}{declaringType.Name}.{field.Name} : {field.FieldType.Name} = ");

                if (value == null)
                {
                    sb.AppendLine("null");
                }
                else if (value is string s)
                {
                    sb.AppendLine($"\"{s}\"");
                }
                else if (value is IEnumerable enumerable)
                {
                    int count = 0;
                    foreach (var _ in enumerable) count++;
                    sb.AppendLine($"<{count} item(s)>");
                }
                else if (TryGetIndexedAccess(value, out var indexedCount, out _))
                {
                    sb.AppendLine($"<{indexedCount} item(s), indexer-based>");
                }
                else if (ShouldRecurse(value, depth, visited))
                {
                    sb.AppendLine(value.ToString());
                    visited.Add(value);
                    DumpFields(sb, value, value.GetType(), depth + 1, visited);
                }
                else
                {
                    sb.AppendLine(value.ToString());
                }
            }
            catch (Exception ex)
            {
                sb.AppendLine($"{indent}{declaringType.Name}.{field.Name} : <error reading field: {ex.Message}>");
            }
        }

        // Only follows plain (non-Unity, non-collection, non-primitive) reference-type objects,
        // and only up to MaxDepth, to avoid dumping half the object graph or looping on cycles.
        private static bool ShouldRecurse(object value, int depth, HashSet<object> visited)
        {
            if (depth >= MaxDepth) return false;
            if (visited.Contains(value)) return false;

            var type = value.GetType();
            if (!type.IsClass) return false;
            if (typeof(UnityEngine.Object).IsAssignableFrom(type)) return false;
            if (type.Namespace != null && type.Namespace.StartsWith("System")) return false;

            return true;
        }

        // Reference identity, not value equality, so the cycle guard can't be fooled by two
        // different objects that happen to compare equal.
        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceEqualityComparer Instance = new ReferenceEqualityComparer();
            bool IEqualityComparer<object>.Equals(object x, object y) => ReferenceEquals(x, y);
            int IEqualityComparer<object>.GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }
}
