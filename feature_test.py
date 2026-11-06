def quicksort(items):
    """Return a sorted copy of *items* using quicksort."""
    if len(items) <= 1:
        return items.copy()

    pivot = items[len(items) // 2]
    lower = [item for item in items if item < pivot]
    equal = [item for item in items if item == pivot]
    higher = [item for item in items if item > pivot]
    return quicksort(lower) + equal + quicksort(higher)


def run_tests():
    assert quicksort([]) == []
    assert quicksort([4, 2, 4, 1, 2]) == [1, 2, 2, 4, 4]
    assert quicksort([-3, 5, -1, 0, -3]) == [-3, -3, -1, 0, 5]
    assert quicksort([1, 2, 3, 4, 5]) == [1, 2, 3, 4, 5]


if __name__ == "__main__":
    print("Starting feature tests...")
    run_tests()
    print("All feature tests passed.")
