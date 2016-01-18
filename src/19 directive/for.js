var rinexpr = /^\s*([\s\S]+?)\s+in\s+([\s\S]+?)(?:\s+as\s+([\s\S]+?))?\s*$/
var rkeyvalue = /\(\s*(\w+)\s*,\s*(\w+)\s*\)/
var rremoveRepeat = /^ms-(repeat|each)/
avalon.directive("repeat", {
    is: function (a, b) {
        if (Array.isArray(a)) {
            if (!Array.isArray(b)) {
                return false
            }
            if (a.length !== b.length) {
                return false
            }
            return !a.some(function (el, i) {
                return el !== b[i]
            })
        } else {
            if (!b)
                return false
            return compareObject(a, b)
        }
    },
    init: function (binding) {
        //尝试使用ng风格的 el in array或(index, el) in array
        var expr = binding.expr, match
        if (match = expr.match(rinexpr)) {
            binding.expr = match[2]
            var keyvalue = match[1]
            if (match = keyvalue.match(rkeyvalue)) {
                binding.keyName = match[1]
                binding.itemName = match[2]
            } else {
                binding.itemName = keyvalue
            }
        }

        var vnode = binding.element
        disposeVirtual(vnode.children)

        var template = shimTemplate(vnode, rremoveRepeat) //防止死循环
        var type = binding.type
        var component = new VComponent("ms-" + type, {type: type},
        type === "repeat" ? template : vnode.template.trim())

        var top = binding.vmodel, $outer = {}

        //处理渲染完毕后的回调的函数
        var rendered = getBindingValue(vnode, "data-" + type + "-rendered", top)
        if (typeof rendered === "function") {
            binding.rendered = function (a, b, c) {
                rendered(type === "repeat" ? c : a)
            }
        } else {
            binding.rendered = noop
        }

        if (type === "repeat") {
            // repeat组件会替换旧原来的VElement
            var arr = binding.siblings
            for (var i = 0, el; el = arr[i]; i++) {
                if (el === vnode) {
                    arr[i] = component
                    break
                }
            }
        } else {
            //each组件会替换掉原VComponent组件的所有孩子
            disposeVirtual(vnode.children)
            pushArray(vnode.children, [component])
        }

        binding.element = component //偷龙转风
        //计算上级循环的$outer
        //外层vmodel不存在$outer对象时, $outer为一个空对象
        if (top.hasOwnProperty("$outer") && typeof top.$outer === "object" && top.$outer.names) {
            top.$outer.names.replace(rword, function (name) {
                if (top.hasOwnProperty(name)) {
                    $outer[name] = top[name]
                }
            })
        }
        binding.initNames = initNames
        binding.$outer = $outer
        delete binding.siblings
    },
    change: function (value, binding) {
        console.log("ms-repeat change ...")
        var vnode = binding.element
        if (!vnode || vnode.disposed) {
            return
        }
        var cache = binding.cache || {}
        var newCache = {}, children = [], keys = [], command = {}, last
        //处理keyName, itemName, last

        var repeatArray = Array.isArray(value)
        binding.initNames(repeatArray)
        if (repeatArray) {
            last = value.length - 1
        } else {
            for (var k in value) {
                if (value.hasOwnProperty(k)) {
                    keys.push(k)
                }
            }
            last = keys.length - 1
        }
        //第一次循环,从cache中重复利用虚拟节点及对应的代理VM, 没有就创建空的虚拟节点
        var items = []
        for (var i = 0; i <= last; i++) {
            if (repeatArray) {//如果是数组,以$id或type+值+"_"为键名
                var item = value[i]
                var component = isInCache(cache, item)//从缓存取出立即删掉
            } else {//如果是对象,直接用key为键名
                var key = keys[i]
                item = value[key]
                component = cache[key]
                delete cache[key]
            }
            items.push({
                key: key || i,
                item: item
            })
            children.push(component)
        }

        var reuse = []//回收剩下的虚拟节点
        for (i in cache) {
            reuse.push(cache[i])
            delete cache[i]
        }
        //第二次循环,创建缺失的虚拟节点或proxy
        var newCom
        for (i = 0; i <= last; i++) {
            component = children[i]
            var curItem = items[i].item
            var curKey = items[i].key
            // var proxy = false
            if (component) {//排序时进此分支
                var proxy = component.vmodel
                command[i] = proxy.$index//获取其现在的位置
                //   console.log("((((((", proxy)
            } else {//增删改时进这分支
                component = reuse.shift()//重复利用回收的虚拟节点
                if (!component) {// 如果是splice走这里
                    component = new VComponent("repeat-item", null,
                            vnode._children.map(function (el) {
                                return el.clone()
                            }))
                    newCom = true
                }
                //新建或重利用旧的proxy, item创建一个proxy
                proxy = repeatItemFactory(curItem, curKey, binding, repeatArray,
                        component.item, component.vmodel)
                proxy[binding.keyName] = curKey
                proxy[binding.itemName] = curItem
            }


            if (component.vmodel) {
                command[i] = component.vmodel.$index//获取其现在的位置
                component.vmodel.$hashcode = false
            } else {
                command[i] = component  //标识这里需要新建一个虚拟节点
            }


            proxy.$index = i
            proxy.$first = i === 0
            proxy.$last = i === last
            proxy.$id = value.$id + (repeatArray ? "" : "." + curKey)
            proxy.$outer = binding.$outer
            children[i] = component
            component.vmodel = proxy
            component.item = curItem
            component.itemName = binding.itemName

            if (repeatArray) {
                /* jshint ignore:start */
                (function (array, el) {
                    proxy.$remove = function () {
                        avalon.Array.remove(array, el)
                    }
                })(value, curItem)

                saveInCache(newCache, curItem, component)
                /* jshint ignore:end */
            } else {
                newCache[curKey] = component
            }

            if (newCom) {
                //console.log("创建新节点")
                //对全新的虚拟节点进行绑定
                updateVirtual(component.children, proxy)
                newCom = false
            }

        }

        var vChildren = vnode.children
        vChildren.length = 0
        pushArray(vChildren, children)
        vChildren.unshift(new VComment(vnode.signature + ":start"))
        vChildren.push(new VComment(vnode.signature + ":end"))
        binding.cache = newCache
        if (repeatArray) {
            binding.oldValue = value.concat()
        } else {
            binding.oldValue = newCache
        }
        vnode.repeatCommand = command

        addHook(vnode, binding.rendered, "afterChange", 95)
        addHooks(this, binding)
    },
    update: function (node, vnode, parent) {
        if (!vnode.disposed) {
            var groupText = vnode.signature
            var nodeValue = node.nodeValue
            if (node.nodeType === 8 && /\w+\d+\:start/.test(nodeValue) &&
                    nodeValue !== groupText + ":start"
                    ) {
                updateSignature(node, nodeValue, groupText)
            }

            if (node.nodeType !== 8 || node.nodeValue !== groupText + ":start") {
                var dom = vnode.toDOM()
                var keepChild = avalon.slice(dom.childNodes)
                if (groupText.indexOf("each") === 0) {
                    avalon.clearHTML(parent)
                    parent.appendChild(dom)
                } else {
                    parent.removeChild(node.nextSibling)
                    parent.replaceChild(dom, node)
                }
                updateEntity(keepChild, getRepeatItem(vnode.children), parent)
                return false
            } else {
                var breakText = groupText + ":end"
                var fragment = document.createDocumentFragment()
                //将原有节点移出DOM, 试根据groupText分组
                var command = vnode.repeatCommand, children = [],
                        fragments = [], i, el, next

                var reversal = {}
                for (i in command) {
                    reversal[command[i]] = ~~i
                }
                i = 0
                var showLog = false
                while (next = node.nextSibling) {
                    if (next.nodeValue === breakText) {
                        break
                    } else if (next.nodeValue === groupText) {
                        fragment.appendChild(next)
                        if (typeof reversal[i] === "number") {
                            showLog && avalon.log("使用已有的节点")
                            children[reversal[i]] = fragment
                            delete command[reversal[i]]
                        } else {
                            fragments.push(fragment)
                        }

                        i++
                        fragment = document.createDocumentFragment()
                    } else {
                        fragment.appendChild(next)
                    }
                }

                showLog && avalon.log("一共收集了", i, "repeat-item的节点")
                for (i in command) {
                    fragment = fragments.shift()

                    if (fragment) {
                        showLog && avalon.log("使用已有节点")
                        children[ i ] = fragment
                    } else {
                        showLog && avalon.log("创建新节点")
                        children[ i ] = command[i].toDOM()
                    }
                }

                fragment = document.createDocumentFragment()
                for (i = 0, el; el = children[i++]; ) {
                    fragment.appendChild(el)
                }

                var entity = avalon.slice(fragment.childNodes)
                parent.insertBefore(fragment, node.nextSibling)

                var virtual = []
                vnode.children.forEach(function (el) {
                    pushArray(virtual, el.children)
                })
                updateEntity(entity, virtual, parent)

                return false
            }
        }
        return false
    },
    old: function (binding, oldValue) {
        if (!Array.isArray(oldValue)) {
            var o = binding.oldValue = {}
            for (var i in oldValue) {
                if (oldValue.hasOwnProperty(i)) {
                    o[i] = oldValue[i]
                }
            }
        }
    }
})


function updateSignature(elem, value, text) {
    var group = value.split(":")[0]
    do {
        var nodeValue = elem.nodeValue
        if (elem.nodeType === 8 && nodeValue.indexOf(group) === 0) {
            elem.nodeValue = nodeValue.replace(group, text)
            if (nodeValue.indexOf(":last") > 0) {
                break
            }
        }
    } while (elem = elem.nextSibling)
}

//复杂即错误！！！！


function getRepeatItem(children) {
    var ret = []
    for (var i = 0, el; el = children[i++]; ) {
        if (el.__type__ === "repeat-item") {
            pushArray(ret, el.children)
        } else {
            ret.push(el)
        }
    }
    return ret
}

avalon.directives.each = avalon.directives.repeat

function compareObject(a, b) {
    var atype = avalon.type(a)
    var btype = avalon.type(a)
    if (atype === btype) {
        var aisVM = atype === "object" && a.$id
        var bisVM = btype === "object"
        var hasDetect = {}
        if (aisVM && bisVM) {
            for (var i in a) {
                hasDetect[i] = true
                if ($$skipArray[i])
                    continue
                if (a.hasOwnProperty(i)) {
                    if (!b.hasOwnProperty(i))
                        return false //如果a有b没有
                    if (!compareObject(a[i], b[i]))
                        return false
                }
            }
            for (i in b) {
                if (hasDetect[i]) {
                    continue
                }//如果b有a没有
                return false
            }
            return true
        } else {
            if (btype === "date")
                return a + 0 === b + 0
            return a === b
        }
    } else {
        return false
    }
}

function isInCache(cache, vm) {
    var isObject = Object(vm) === vm, c
    if (isObject) {
        c = cache[vm.$hashcode]
        if (c) {
            delete cache[vm.$hashcode]
        }
        return c
    } else {
        var id = avalon.type(vm) + "_" + vm
        c = cache[id]
        if (c) {
            var stack = [{id: id, c: c}]
            while (1) {
                id += "_"
                if (cache[id]) {
                    stack.push({
                        id: id,
                        c: cache[id]
                    })
                } else {
                    break
                }
            }
            var a = stack.pop()
            delete cache[a.id]
            return a.c
        }
        return c
    }
}

function saveInCache(cache, vm, component) {
    if (Object(vm) === vm) {
        cache[vm.$hashcode] = component
    } else {
        var type = avalon.type(vm)
        var trackId = type + "_" + vm
        if (!cache[trackId]) {
            cache[trackId] = component
        } else {
            while (1) {
                trackId += "_"
                if (!cache[trackId]) {
                    cache[trackId] = component
                    break
                }
            }
        }
    }
}

function initNames(repeatArray) {
    var binding = this
    if (repeatArray) {
        if (!binding.itemName) {
            binding.itemName = binding.param || "el"
            delete binding.param
        }
        if (!binding.keyName) {
            binding.keyName = "$index"
        }
    } else {
        if (!binding.keyName) {
            binding.keyName = "$key"
        }
        if (!binding.itemName) {
            binding.itemName = "$val"
        }

    }
    //处理$outer.names
    if (!binding.$outer.names) {
        var names = ["$first", "$last", "$index", "$outer"]
        if (repeatArray) {
            names.push("$remove")
        }
        avalon.Array.ensure(names, binding.itemName)
        avalon.Array.ensure(names, binding.keyName)

        binding.$outer.names = names.join(",")
    }
    this.initNames = noop
}

//顶层的可以复用
function repeatItemFactory(item, name, binding, repeatArray, oldItem, oldProxy) {

    var before = binding.vmodel//上一级的VM
    console.log(before, "::::")
    var heirloom = {}
    if (oldItem && item && item.$events) {
        item.$events = oldItem.$events
        item.$events.__vmodel__ = item
    }

    if (item && item.$id && !Array.isArray(before)) {
        before = proxyFactory(before, item, heirloom)
    }
    var keys = [binding.keyName, binding.itemName, "$index", "$first", "$last"]
    var after = {
        $accessors: {},
        $outer: 1
    }

    for (var i = 0, key; key = keys[i++]; ) {
        if (oldProxy) {
            after.$accessors[key] = oldProxy.$accessors[key]
        } else {
            after.$accessors[key] = makeObservable("", key, heirloom)
        }
    }
    if (repeatArray) {
        after.$remove = noop
    }

    if (Object.defineProperties) {
        Object.defineProperties(after, after.$accessors)
    }
    var vm = proxyFactory(before, after, heirloom)
    if (oldProxy) {
        vm.$hashcode = oldProxy.$hashcode
    } else {
        vm.$hashcode =
                makeHashCode((repeatArray ? "a" : "o") + ":" + binding.itemName + ":")
    }
    if (!repeatArray) {
        var match = String(before.$hashcode).match(/^(a|o):(\S+):(?:\d+)$/)

        //数组循环中的对象循环,得到数组元素
        if (match && match[1] === "a") {
            before = before[match[2]]
            var path = name
        } else {
            path = binding.expr + "." + name
        }
        before.$watch(path, function (v) {
            //比如outerVm.object.aaa = 8需要同步到innerVm.$val
            vm[binding.itemName] = v
        })
    } else {//处理el.length
        vm.$watch(binding.itemName, function (a) {
            if (Array.isArray(a))
                $emit(vm.$events[binding.itemName + ".length"], a.length)
        })
    }


    return  vm
}






avalon.repeatItemFactory = repeatItemFactory