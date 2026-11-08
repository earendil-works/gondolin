//! Small insertion-ordered map and set (linear lookups) for the session's
//! per-exec bookkeeping, which holds at most a few hundred entries and must
//! iterate in insertion order like the node engine's `Map`s.

/// An insertion-ordered map.
#[derive(Debug, Clone)]
pub struct OrderedMap<K, V> {
    entries: Vec<(K, V)>,
}

impl<K, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        OrderedMap { entries: Vec::new() }
    }
}

impl<K: PartialEq, V> OrderedMap<K, V> {
    pub fn new() -> Self {
        Self::default()
    }

    fn position(&self, key: &K) -> Option<usize> {
        self.entries.iter().position(|(k, _)| k == key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn contains_key(&self, key: &K) -> bool {
        self.position(key).is_some()
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Inserts or replaces (an existing key keeps its position).
    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        match self.position(&key) {
            Some(i) => Some(std::mem::replace(&mut self.entries[i].1, value)),
            None => {
                self.entries.push((key, value));
                None
            }
        }
    }

    /// Removes `key`, keeping the order of the others.
    pub fn shift_remove(&mut self, key: &K) -> Option<V> {
        let i = self.position(key)?;
        Some(self.entries.remove(i).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(k, _)| k)
    }

    /// The value of `key`, inserted with `make` when absent.
    pub fn entry_or_insert_with(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        let i = match self.position(&key) {
            Some(i) => i,
            None => {
                self.entries.push((key, make()));
                self.entries.len() - 1
            }
        };
        &mut self.entries[i].1
    }
}

/// An insertion-ordered set.
#[derive(Debug, Clone)]
pub struct OrderedSet<K> {
    map: OrderedMap<K, ()>,
}

impl<K> Default for OrderedSet<K> {
    fn default() -> Self {
        OrderedSet { map: OrderedMap::default() }
    }
}

impl<K: PartialEq> OrderedSet<K> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }

    pub fn contains(&self, key: &K) -> bool {
        self.map.contains_key(key)
    }

    /// Returns whether `key` was new.
    pub fn insert(&mut self, key: K) -> bool {
        self.map.insert(key, ()).is_none()
    }

    /// Returns whether `key` was present.
    pub fn shift_remove(&mut self, key: &K) -> bool {
        self.map.shift_remove(key).is_some()
    }

    pub fn iter(&self) -> impl Iterator<Item = &K> {
        self.map.keys()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_and_replacement() {
        let mut m = OrderedMap::new();
        m.insert(3, "c");
        m.insert(1, "a");
        m.insert(2, "b");
        assert_eq!(m.insert(3, "C"), Some("c"));
        assert_eq!(m.keys().copied().collect::<Vec<_>>(), vec![3, 1, 2]);
        assert_eq!(m.shift_remove(&1), Some("a"));
        assert_eq!(m.iter().map(|(k, v)| (*k, *v)).collect::<Vec<_>>(), vec![(3, "C"), (2, "b")]);
        *m.entry_or_insert_with(9, || "z") = "y";
        assert_eq!(m.get(&9), Some(&"y"));
        let mut s = OrderedSet::new();
        assert!(s.insert(5) && !s.insert(5));
        assert!(s.shift_remove(&5) && s.is_empty());
    }
}
